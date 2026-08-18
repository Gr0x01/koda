/**
 * One owner for project skill identity across prompt routing, Settings, Claude, and Codex.
 * Claude takes a skill's engine-visible name from SKILL.md frontmatter, so directory names are
 * locations only. Ambiguous or path-like identities fail closed everywhere that consumes this file.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ProjectSkillDescriptor {
  name: string
  directoryName: string
  file: string
}

export function slugifyBehaviorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Native skill names are lowercase slugs. Return the safe canonical identity or reject it. */
export function canonicalSkillName(name: string): string | null {
  const slug = slugifyBehaviorName(name)
  return slug && name === slug ? slug : null
}

function frontmatterName(file: string): string | undefined {
  try {
    const text = readFileSync(file, 'utf8')
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
    if (!block) return undefined
    const value = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, '')
    return value || undefined
  } catch {
    return undefined
  }
}

function skillDirectories(projectRoot: string): string[] {
  const dir = join(projectRoot, '.claude', 'skills')
  try {
    return existsSync(dir) ? readdirSync(dir) : []
  } catch {
    return []
  }
}

/** All valid identity claims, including duplicates. Mutation checks need the raw claims so creating a
 * third copy cannot turn an already-ambiguous identity into a different Settings target. */
export function projectSkillClaims(projectRoot: string): ProjectSkillDescriptor[] {
  const dir = join(projectRoot, '.claude', 'skills')
  return skillDirectories(projectRoot)
    .map((directoryName) => {
      const file = join(dir, directoryName, 'SKILL.md')
      if (!existsSync(file)) return null
      const candidate = frontmatterName(file) || directoryName
      const name = canonicalSkillName(candidate)
      if (!name) return null
      return { name, directoryName, file }
    })
    .filter((descriptor): descriptor is ProjectSkillDescriptor => descriptor !== null)
}

export function projectSkillDescriptors(projectRoot: string): ProjectSkillDescriptor[] {
  const descriptors = projectSkillClaims(projectRoot)
  const counts = new Map<string, number>()
  for (const descriptor of descriptors)
    counts.set(descriptor.name, (counts.get(descriptor.name) ?? 0) + 1)
  return descriptors.filter((descriptor) => counts.get(descriptor.name) === 1)
}

export function projectSkillCollisionNames(projectRoot: string): string[] {
  const counts = new Map<string, number>()
  for (const descriptor of projectSkillClaims(projectRoot))
    counts.set(descriptor.name, (counts.get(descriptor.name) ?? 0) + 1)
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort()
}
