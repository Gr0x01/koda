import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseAppManifest,
  crashBackoffMs,
  installApp,
  startApp,
  stopApp,
  appStatus,
  listMiniApps,
  startRegisteredMiniApp,
  deleteProjectApps,
  APP_MANIFEST,
} from './mini-apps'

/**
 * The supervisor's pure seams: the manifest contract the create-mini-app skill builds against (a schema
 * drift here silently breaks every recipe-built app), and the crash-backoff policy (a regression to
 * unbounded or zero backoff turns a broken app into a spawn loop).
 */

describe('koda-app.json manifest', () => {
  it('accepts the full documented shape', () => {
    const m = parseAppManifest(
      JSON.stringify({
        name: 'Fitness',
        entry: 'node server.js',
        icon: 'icon.png',
        data: ['data/fitness.sqlite'],
        shared: [{ path: 'shared-data/meals', mode: 'read' }],
      }),
    )
    expect(m.name).toBe('Fitness')
    expect(m.entry).toBe('node server.js')
    expect(m.shared?.[0].mode).toBe('read')
  })

  it('accepts the minimal shape (name + entry only)', () => {
    const m = parseAppManifest(JSON.stringify({ name: 'x', entry: 'npm start' }))
    expect(m.icon).toBeUndefined()
    expect(m.data).toBeUndefined()
  })

  it('tolerates unknown keys (an older Koda must not reject a newer manifest)', () => {
    expect(() => parseAppManifest(JSON.stringify({ name: 'x', entry: 'y', futureField: 1 }))).not.toThrow()
  })

  it('rejects a missing entry with a plain, named message', () => {
    expect(() => parseAppManifest(JSON.stringify({ name: 'x' }))).toThrow(APP_MANIFEST)
  })

  it('rejects a bad shared mode', () => {
    expect(() =>
      parseAppManifest(JSON.stringify({ name: 'x', entry: 'y', shared: [{ path: 'p', mode: 'write' }] })),
    ).toThrow(/invalid/)
  })

  it('rejects non-JSON with a plain message', () => {
    expect(() => parseAppManifest('{nope')).toThrow(/not valid JSON/)
  })
})

describe('crash backoff', () => {
  it('grows exponentially from 1s and caps at 30s', () => {
    expect(crashBackoffMs(1)).toBe(1_000)
    expect(crashBackoffMs(2)).toBe(2_000)
    expect(crashBackoffMs(3)).toBe(4_000)
    expect(crashBackoffMs(10)).toBe(30_000)
  })
})

// End-to-end against a REAL child process (the electron stub points userData at tmpdir, so the
// registry file lands there too). This is the contract the recipe builds against: assigned PORT via
// env, resolve only once serving, stop really kills the process group.
describe('supervisor lifecycle (real process)', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'koda-miniapp-'))
  const appDir = join(projectPath, 'apps', 'demo')
  const brokenDir = join(projectPath, 'apps', 'broken')

  beforeAll(() => {
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      join(appDir, 'server.js'),
      `const http = require('node:http')
       http.createServer((req, res) => res.end('ok from demo')).listen(process.env.PORT, '127.0.0.1')`,
    )
    writeFileSync(join(appDir, APP_MANIFEST), JSON.stringify({ name: 'Demo', entry: 'node server.js' }))
    mkdirSync(brokenDir, { recursive: true })
    writeFileSync(join(brokenDir, APP_MANIFEST), JSON.stringify({ name: 'Broken', entry: 'node -e "process.exit(3)"' }))
  })

  afterAll(async () => {
    await stopApp(appDir).catch(() => {})
    await stopApp(brokenDir).catch(() => {})
    rmSync(projectPath, { recursive: true, force: true })
  })

  it('install registers without marking the app desired-running', async () => {
    const result = await installApp(appDir, projectPath)
    expect(result.name).toBe('Demo')
    const status = await appStatus(projectPath)
    expect(status.find((s) => s.name === 'Demo')?.startsOnLaunch).toBe(false)
  })

  it('start assigns the port, waits for serving, and stop really kills it', async () => {
    const { url, port } = await startApp(appDir, projectPath)
    expect(url).toBe(`http://localhost:${port}`)
    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(await res.text()).toBe('ok from demo')

    let demo = (await appStatus(projectPath)).find((s) => s.name === 'Demo')
    expect(demo?.state).toBe('running')
    expect(demo?.startsOnLaunch).toBe(true) // proven to serve → kept alive across relaunches
    expect(demo?.pid).toBeGreaterThan(0)

    // Idempotent: a second start joins the running app instead of double-spawning.
    expect((await startApp(appDir, projectPath)).port).toBe(port)

    await stopApp(appDir)
    demo = (await appStatus(projectPath)).find((s) => s.name === 'Demo')
    expect(demo?.state).toBe('stopped')
    expect(demo?.startsOnLaunch).toBe(false)
    // The process group is actually dead — the port refuses within the grace of a SIGTERM.
    await new Promise((r) => setTimeout(r, 300))
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  }, 20_000)

  it('an app that exits before serving fails the start with a clear error and leaves no phantom pid', async () => {
    await expect(startApp(brokenDir, projectPath)).rejects.toThrow(/exited \(code 3\) before serving/)
    // The dead child must leave the table — a phantom pid would also make every quit eat the SIGKILL grace.
    const broken = (await appStatus(projectPath)).find((s) => s.name === 'Broken')
    expect(broken?.pid).toBeUndefined()
    expect(broken?.state).toBe('stopped')
  }, 20_000)

  it('a stop that lands mid-start wins — the app must not come up running', async () => {
    // A server that waits before listening, so the start is still probing when stop arrives.
    const slowDir = join(projectPath, 'apps', 'slow')
    mkdirSync(slowDir, { recursive: true })
    writeFileSync(
      join(slowDir, 'server.js'),
      `setTimeout(() => {
         const http = require('node:http')
         http.createServer((req, res) => res.end('slow')).listen(process.env.PORT, '127.0.0.1')
       }, 1500)`,
    )
    writeFileSync(join(slowDir, APP_MANIFEST), JSON.stringify({ name: 'Slow', entry: 'node server.js' }))

    const starting = startApp(slowDir, projectPath)
    starting.catch(() => {}) // assert via expect below; don't leave an unhandled rejection window
    await new Promise((r) => setTimeout(r, 300))
    await stopApp(slowDir)
    await expect(starting).rejects.toThrow(/stopped while starting/)
    const slow = (await appStatus(projectPath)).find((s) => s.name === 'Slow')
    expect(slow?.state).toBe('stopped')
    expect(slow?.startsOnLaunch).toBe(false)
  }, 20_000)

  it('a folder without a manifest fails with a plain instruction', async () => {
    await expect(installApp(projectPath, projectPath)).rejects.toThrow(new RegExp(`no ${APP_MANIFEST}`))
  })

  // The renderer-facing seam (the face): list carries every registered app + live state, and start
  // only accepts a REGISTERED dir — the renderer must never be able to run an arbitrary folder.
  it('listMiniApps reports registered apps across projects with live state', async () => {
    const apps = await listMiniApps()
    const demo = apps.find((a) => a.dir === appDir)
    expect(demo?.name).toBe('Demo')
    expect(demo?.projectPath).toBe(projectPath)
    expect(demo?.state).toBe('stopped') // stopped earlier in the lifecycle test
    expect(demo?.url).toBeUndefined()
  })

  it('startRegisteredMiniApp rejects an unregistered dir and starts a registered one', async () => {
    await expect(startRegisteredMiniApp(join(tmpdir(), 'not-an-app'))).rejects.toThrow(/not registered/)
    const { url, port } = await startRegisteredMiniApp(appDir)
    expect(url).toBe(`http://localhost:${port}`)
    expect((await listMiniApps()).find((a) => a.dir === appDir)?.state).toBe('running')
    await stopApp(appDir)
  }, 20_000)

  it('listMiniApps prunes entries whose folder is gone (project deleted outside Koda)', async () => {
    const goneProject = mkdtempSync(join(tmpdir(), 'koda-gone-'))
    const goneDir = join(goneProject, 'apps', 'gone')
    mkdirSync(goneDir, { recursive: true })
    writeFileSync(join(goneDir, APP_MANIFEST), JSON.stringify({ name: 'Gone', entry: 'node server.js' }))
    await installApp(goneDir, goneProject)
    expect((await listMiniApps()).some((a) => a.dir === goneDir)).toBe(true)
    rmSync(goneProject, { recursive: true, force: true })
    expect((await listMiniApps()).some((a) => a.dir === goneDir)).toBe(false)
  })

  // Runs last within the describe: project deletion must leave nothing registered, running, or
  // restartable — unlike stop, which keeps the entry for the next launch.
  it('deleteProjectApps stops the running app and deregisters the whole project', async () => {
    await startRegisteredMiniApp(appDir)
    await deleteProjectApps(projectPath)
    expect(await appStatus(projectPath)).toEqual([])
    expect((await listMiniApps()).some((a) => a.projectPath === projectPath)).toBe(false)
  }, 20_000)
})
