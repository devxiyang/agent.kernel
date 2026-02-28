import { readdirSync, statSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionInfo = {
  sessionId:    string
  updatedAt:    number // log.jsonl mtime in milliseconds
  messageCount: number // number of entries in log.jsonl
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
      sessions.push({ sessionId, updatedAt: stat.mtimeMs, messageCount: 0 })
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

    sessions.push({ sessionId, updatedAt, messageCount })
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
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
