import { readdirSync, statSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionMeta } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionInfo = {
  sessionId:    string
  updatedAt:    number // log.jsonl mtime in milliseconds
  messageCount: number // number of entries in log.jsonl
  meta:         SessionMeta | null
}

// ─── listSessions ─────────────────────────────────────────────────────────────

/**
 * List all sessions under `dir`, sorted by most recently updated first.
 * Returns [] if `dir` does not exist or contains no sessions.
 */
export function listSessions(dir: string): SessionInfo[] {
  if (!existsSync(dir)) return []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const sessions: SessionInfo[] = []

  for (const sessionId of entries) {
    const sessionDir = join(dir, sessionId)
    const logPath    = join(sessionDir, 'log.jsonl')

    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(sessionDir)
      if (!stat.isDirectory()) continue
    } catch {
      continue
    }

    if (!existsSync(logPath)) {
      let meta: SessionMeta | null = null
      const metaPath = join(sessionDir, 'meta.json')
      if (existsSync(metaPath)) {
        try { meta = JSON.parse(readFileSync(metaPath, 'utf-8')) } catch {}
      }
      sessions.push({ sessionId, updatedAt: stat.mtimeMs, messageCount: 0, meta })
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
      // Malformed log — still include the session with what we have
    }

    let meta: SessionMeta | null = null
    const metaPath = join(sessionDir, 'meta.json')
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, 'utf-8')) } catch {}
    }

    sessions.push({ sessionId, updatedAt, messageCount, meta })
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ─── updateSessionMeta ────────────────────────────────────────────────────────

/**
 * Merge metadata fields into an existing session's meta.json.
 * `createdAt` is protected and cannot be overwritten.
 * Silent no-op if the session does not have a meta.json yet.
 */
export function updateSessionMeta(
  dir:       string,
  sessionId: string,
  meta:      Partial<Omit<SessionMeta, 'createdAt'>>,
): void {
  const metaPath = join(dir, sessionId, 'meta.json')
  if (!existsSync(metaPath)) return
  const existing: SessionMeta = JSON.parse(readFileSync(metaPath, 'utf-8'))
  writeFileSync(metaPath, JSON.stringify({ ...existing, ...meta }))
}

// ─── deleteSession ────────────────────────────────────────────────────────────

/**
 * Delete a session directory and all its contents.
 * Silent no-op if `dir` or `sessionId` does not exist.
 */
export function deleteSession(dir: string, sessionId: string): void {
  const sessionDir = join(dir, sessionId)
  if (!existsSync(sessionDir)) return
  rmSync(sessionDir, { recursive: true, force: true })
}
