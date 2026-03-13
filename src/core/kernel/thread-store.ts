import { readdirSync, statSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ThreadMeta } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ThreadInfo = {
  threadId:    string
  updatedAt:    number // log.jsonl mtime in milliseconds
  messageCount: number // number of entries in log.jsonl
  meta:         ThreadMeta | null
}

// ─── listThreads ─────────────────────────────────────────────────────────────

/**
 * List all threads under `dir`, sorted by most recently updated first.
 * Returns [] if `dir` does not exist or contains no threads.
 *
 * Archived threads (meta.archived === true) are excluded by default.
 * Pass `{ includeArchived: true }` to include them.
 */
export function listThreads(dir: string, options?: { includeArchived?: boolean }): ThreadInfo[] {
  if (!existsSync(dir)) return []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const sessions: ThreadInfo[] = []

  for (const threadId of entries) {
    const sessionDir = join(dir, threadId)
    const logPath    = join(sessionDir, 'log.jsonl')

    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(sessionDir)
      if (!stat.isDirectory()) continue
    } catch {
      continue
    }

    if (!existsSync(logPath)) {
      let meta: ThreadMeta | null = null
      const metaPath = join(sessionDir, 'meta.json')
      if (existsSync(metaPath)) {
        try { meta = JSON.parse(readFileSync(metaPath, 'utf-8')) } catch {}
      }
      sessions.push({ threadId, updatedAt: stat.mtimeMs, messageCount: 0, meta })
      continue
    }

    let updatedAt    = stat.mtimeMs
    let messageCount = 0

    try {
      const logStat = statSync(logPath)
      updatedAt = logStat.mtimeMs

      const content = readFileSync(logPath, 'utf-8')
      messageCount  = content.split('\n').filter(l => l.trim() !== '').length
    } catch {
      // Malformed log — still include the thread with what we have
    }

    let meta: ThreadMeta | null = null
    const metaPath = join(sessionDir, 'meta.json')
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, 'utf-8')) } catch {}
    }

    sessions.push({ threadId, updatedAt, messageCount, meta })
  }

  const includeArchived = options?.includeArchived ?? false
  const filtered = includeArchived
    ? sessions
    : sessions.filter(s => !s.meta?.archived)

  return filtered.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ─── updateThreadMeta ────────────────────────────────────────────────────────

/**
 * Merge metadata fields into an existing session's meta.json.
 * `createdAt` is protected and cannot be overwritten.
 * Silent no-op if the thread does not have a meta.json yet.
 */
export function updateThreadMeta(
  dir:       string,
  threadId: string,
  meta:      Partial<Omit<ThreadMeta, 'createdAt'>>,
): void {
  const metaPath = join(dir, threadId, 'meta.json')
  if (!existsSync(metaPath)) return
  const existing: ThreadMeta = JSON.parse(readFileSync(metaPath, 'utf-8'))
  writeFileSync(metaPath, JSON.stringify({ ...existing, ...meta }))
}

// ─── deleteThread ────────────────────────────────────────────────────────────

/**
 * Delete a thread directory and all its contents.
 * Silent no-op if `dir` or `threadId` does not exist.
 */
export function deleteThread(dir: string, threadId: string): void {
  const sessionDir = join(dir, threadId)
  if (!existsSync(sessionDir)) return
  rmSync(sessionDir, { recursive: true, force: true })
}
