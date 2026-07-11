import os from 'node:os'
import { readFileSync } from 'node:fs'
import { app, nativeImage } from 'electron'
import type { FeedbackRequest, FeedbackResult } from '@shared/ipc'
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, FEEDBACK_HANDSHAKE } from './koda-service-config'
import { probeEngine } from './engine/probe'
import { loadSettings } from './settings'
import { currentLogFile, log } from './logger'

/**
 * In-app feedback → the Supabase `feedback` edge fn, which writes a row to the PRIVATE feedback inbox
 * and stashes any attachment in a private bucket (decision 2026-07-09: private, so a screenshot/logs
 * that may contain the user's paths or prompts never hit a public surface). This Mac half gathers the
 * safe diagnostics itself (version, OS, engine, billing) rather than trusting the renderer, downsizes
 * the attached screenshot to bound the payload, and reads the log tail only when the user opted in.
 *
 * The handshake is defence-in-depth, not a secret: the edge fn enforces it only when its
 * FEEDBACK_SECRET env matches this value — raising the bar on a discovered-URL spam run without
 * pretending a bundled constant is private.
 */
const MAX_IMAGE_WIDTH = 1800
const MAX_LOG_BYTES = 200_000

/** A coarse OS string for triage (e.g. "darwin 24.5.0"); no machine identifiers. */
function osLabel(): string {
  return `${process.platform} ${os.release()}`
}

/** Downsize an attached screenshot and re-encode as JPEG to keep the POST small. Returns the raw
 *  base64 (no data: prefix) or null if the image can't be read. */
function prepareScreenshot(dataUrl: string): string | null {
  try {
    let img = nativeImage.createFromDataURL(dataUrl)
    if (img.isEmpty()) return null
    const { width } = img.getSize()
    if (width > MAX_IMAGE_WIDTH) img = img.resize({ width: MAX_IMAGE_WIDTH })
    return img.toJPEG(85).toString('base64')
  } catch {
    return null
  }
}

/** The tail of this run's log file (last MAX_LOG_BYTES), for an opted-in bug report. */
function recentLogs(): string | null {
  const path = currentLogFile()
  if (!path) return null
  try {
    const buf = readFileSync(path)
    return buf.subarray(Math.max(0, buf.length - MAX_LOG_BYTES)).toString('utf8')
  } catch {
    return null
  }
}

export async function submitFeedback(req: FeedbackRequest): Promise<FeedbackResult> {
  // Diagnostics gathered here, never trusted from the renderer. Engine probe is best-effort.
  let engineVersion: string | undefined
  try {
    engineVersion = (await probeEngine(app.isPackaged ? process.resourcesPath : undefined)).version
  } catch {
    engineVersion = undefined
  }

  const screenshot = req.screenshot ? prepareScreenshot(req.screenshot) : null
  const logs = req.includeLogs ? recentLogs() : null

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/feedback`, {
      method: 'POST',
      // apikey is the canonical Supabase gateway header (matches the apns-push call); the publishable
      // key is already bundled and safe. x-koda-feedback is the optional abuse handshake.
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_PUBLISHABLE_KEY,
        'x-koda-feedback': FEEDBACK_HANDSHAKE,
      },
      body: JSON.stringify({
        kind: req.kind,
        message: req.message,
        email: req.email || undefined,
        version: app.getVersion(),
        os: osLabel(),
        engineVersion,
        billingMode: loadSettings().billingMode,
        screenshot: screenshot || undefined,
        screenshotType: 'image/jpeg',
        logs: logs || undefined,
      }),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean }
    if (res.ok && data.ok) return { ok: true }
    log.warn('feedback', `submit rejected: ${res.status}`)
    return { ok: false, error: "Couldn't send that just now. Please try again in a moment." }
  } catch (err) {
    log.warn('feedback', 'submit failed', err instanceof Error ? err.message : err)
    return { ok: false, error: 'No connection. Check your network and try again.' }
  }
}
