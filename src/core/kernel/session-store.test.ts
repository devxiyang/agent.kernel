import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listSessions, deleteSession } from './session-store.js'
import { createKernel } from './kernel.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

let baseDir: string

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'session-store-test-'))
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

function seedSession(sessionId: string, withMessages = true): void {
  const kernel = createKernel({ dir: baseDir, sessionId })
  if (withMessages) {
    kernel.append({ type: 'user', payload: { parts: [{ type: 'text', text: 'hello' }] } })
    kernel.append({ type: 'assistant', payload: { text: 'reply', toolCalls: [], stopReason: 'stop' } })
  }
}

// ─── listSessions ─────────────────────────────────────────────────────────────

describe('listSessions', () => {
  it('returns [] when dir does not exist', () => {
    expect(listSessions('/nonexistent/path/xyz')).toEqual([])
  })

  it('returns [] when dir exists but is empty', () => {
    expect(listSessions(baseDir)).toEqual([])
  })

  it('returns one SessionInfo per session', () => {
    seedSession('sess-a')
    seedSession('sess-b')
    expect(listSessions(baseDir)).toHaveLength(2)
  })

  it('includes sessionId, updatedAt, and messageCount', () => {
    seedSession('sess-1')
    const info = listSessions(baseDir)[0]
    expect(info.sessionId).toBe('sess-1')
    expect(info.updatedAt).toBeGreaterThan(0)
    expect(info.messageCount).toBeGreaterThan(0)
  })

  it('sets messageCount to 0 for sessions with no log', () => {
    mkdirSync(join(baseDir, 'empty-sess'), { recursive: true })
    const info = listSessions(baseDir)[0]
    expect(info.messageCount).toBe(0)
  })

  it('sorts sessions by updatedAt descending (most recent first)', async () => {
    seedSession('old-sess')
    await new Promise(r => setTimeout(r, 10))
    seedSession('new-sess')
    const list = listSessions(baseDir)
    expect(list[0].sessionId).toBe('new-sess')
    expect(list[1].sessionId).toBe('old-sess')
  })

  it('skips non-directory entries inside dir', () => {
    seedSession('real-sess')
    writeFileSync(join(baseDir, 'not-a-session.txt'), 'noise')
    const list = listSessions(baseDir)
    expect(list).toHaveLength(1)
    expect(list[0].sessionId).toBe('real-sess')
  })

  it('handles sessions with malformed log.jsonl gracefully', () => {
    const sessionDir = join(baseDir, 'bad-sess')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'log.jsonl'), 'not valid json\n{broken')
    expect(() => listSessions(baseDir)).not.toThrow()
  })
})

// ─── deleteSession ────────────────────────────────────────────────────────────

describe('deleteSession', () => {
  it('removes the session directory', () => {
    seedSession('to-delete')
    deleteSession(baseDir, 'to-delete')
    expect(listSessions(baseDir)).toHaveLength(0)
  })

  it('is a no-op when sessionId does not exist', () => {
    expect(() => deleteSession(baseDir, 'ghost-session')).not.toThrow()
  })

  it('is a no-op when dir does not exist', () => {
    expect(() => deleteSession('/nonexistent/dir', 'sess')).not.toThrow()
  })

  it('does not affect other sessions', () => {
    seedSession('keep-me')
    seedSession('delete-me')
    deleteSession(baseDir, 'delete-me')
    const list = listSessions(baseDir)
    expect(list).toHaveLength(1)
    expect(list[0].sessionId).toBe('keep-me')
  })
})
