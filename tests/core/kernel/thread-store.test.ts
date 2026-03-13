import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listThreads, deleteThread, updateThreadMeta } from '../../../src/core/kernel/thread-store.js'
import { createKernel } from '../../../src/core/kernel/kernel.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

let baseDir: string

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'thread-store-test-'))
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

function seedSession(threadId: string, withMessages = true): void {
  const kernel = createKernel({ dir: baseDir, threadId })
  if (withMessages) {
    kernel.append({ type: 'user', parts: [{ type: 'text', text: 'hello' }] })
    kernel.append({ type: 'assistant', parts: [{ type: 'text', text: 'reply' }], stopReason: 'stop' })
  }
}

// ─── listThreads ─────────────────────────────────────────────────────────────

describe('listThreads', () => {
  it('returns [] when dir does not exist', () => {
    expect(listThreads('/nonexistent/path/xyz')).toEqual([])
  })

  it('returns [] when dir exists but is empty', () => {
    expect(listThreads(baseDir)).toEqual([])
  })

  it('returns one ThreadInfo per session', () => {
    seedSession('sess-a')
    seedSession('sess-b')
    expect(listThreads(baseDir)).toHaveLength(2)
  })

  it('includes threadId, updatedAt, and messageCount', () => {
    seedSession('sess-1')
    const info = listThreads(baseDir)[0]
    expect(info.threadId).toBe('sess-1')
    expect(info.updatedAt).toBeGreaterThan(0)
    expect(info.messageCount).toBeGreaterThan(0)
  })

  it('sets messageCount to 0 for sessions with no log', () => {
    mkdirSync(join(baseDir, 'empty-sess'), { recursive: true })
    const info = listThreads(baseDir)[0]
    expect(info.messageCount).toBe(0)
  })

  it('sorts sessions by updatedAt descending (most recent first)', async () => {
    seedSession('old-sess')
    await new Promise(r => setTimeout(r, 10))
    seedSession('new-sess')
    const list = listThreads(baseDir)
    expect(list[0].threadId).toBe('new-sess')
    expect(list[1].threadId).toBe('old-sess')
  })

  it('skips non-directory entries inside dir', () => {
    seedSession('real-sess')
    writeFileSync(join(baseDir, 'not-a-session.txt'), 'noise')
    const list = listThreads(baseDir)
    expect(list).toHaveLength(1)
    expect(list[0].threadId).toBe('real-sess')
  })

  it('handles sessions with malformed log.jsonl gracefully', () => {
    const sessionDir = join(baseDir, 'bad-sess')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'log.jsonl'), 'not valid json\n{broken')
    expect(() => listThreads(baseDir)).not.toThrow()
  })
})

// ─── deleteThread ────────────────────────────────────────────────────────────

describe('deleteThread', () => {
  it('removes the session directory', () => {
    seedSession('to-delete')
    deleteThread(baseDir, 'to-delete')
    expect(listThreads(baseDir)).toHaveLength(0)
  })

  it('is a no-op when threadId does not exist', () => {
    expect(() => deleteThread(baseDir, 'ghost-session')).not.toThrow()
  })

  it('is a no-op when dir does not exist', () => {
    expect(() => deleteThread('/nonexistent/dir', 'sess')).not.toThrow()
  })

  it('does not affect other sessions', () => {
    seedSession('keep-me')
    seedSession('delete-me')
    deleteThread(baseDir, 'delete-me')
    const list = listThreads(baseDir)
    expect(list).toHaveLength(1)
    expect(list[0].threadId).toBe('keep-me')
  })
})

// ─── session metadata ─────────────────────────────────────────────────────────

describe('session metadata', () => {
  it('listThreads returns meta: null for sessions with no meta.json', () => {
    // Create a directory without going through createKernel (so no meta.json)
    mkdirSync(join(baseDir, 'bare-sess'), { recursive: true })
    writeFileSync(join(baseDir, 'bare-sess', 'log.jsonl'), '')
    const info = listThreads(baseDir)[0]
    expect(info.meta).toBeNull()
  })

  it('listThreads returns meta including createdAt when session is created via createKernel', () => {
    seedSession('meta-sess')
    const info = listThreads(baseDir)[0]
    expect(info.meta).not.toBeNull()
    expect(typeof info.meta!.createdAt).toBe('number')
    expect(info.meta!.createdAt).toBeGreaterThan(0)
  })

  it('listThreads returns title when session is created with meta', () => {
    createKernel({ dir: baseDir, threadId: 'titled-sess', meta: { title: 'My Session' } })
    const info = listThreads(baseDir)[0]
    expect(info.meta?.title).toBe('My Session')
  })

  it('returns meta: null for empty session dir without meta.json', () => {
    mkdirSync(join(baseDir, 'no-meta'), { recursive: true })
    const info = listThreads(baseDir)[0]
    expect(info.meta).toBeNull()
  })

  it('sets createdAt once and does not overwrite it on subsequent opens', () => {
    createKernel({ dir: baseDir, threadId: 'stable-sess' })
    const firstInfo = listThreads(baseDir)[0]
    const firstCreatedAt = firstInfo.meta!.createdAt

    // Re-open the same session
    createKernel({ dir: baseDir, threadId: 'stable-sess' })
    const secondInfo = listThreads(baseDir)[0]
    expect(secondInfo.meta!.createdAt).toBe(firstCreatedAt)
  })

  it('merges new meta fields on subsequent opens without touching createdAt', () => {
    createKernel({ dir: baseDir, threadId: 'merge-sess' })
    const { meta: first } = listThreads(baseDir)[0]
    const originalCreatedAt = first!.createdAt

    // Re-open with a title
    createKernel({ dir: baseDir, threadId: 'merge-sess', meta: { title: 'Added later' } })
    const { meta: second } = listThreads(baseDir)[0]

    expect(second!.createdAt).toBe(originalCreatedAt)
    expect(second!.title).toBe('Added later')
  })
})

// ─── archived filtering ───────────────────────────────────────────────────────

describe('listThreads — archived filtering', () => {
  it('excludes archived threads by default', () => {
    seedSession('active-sess')
    seedSession('archived-sess')
    updateThreadMeta(baseDir, 'archived-sess', { archived: true })
    const list = listThreads(baseDir)
    expect(list).toHaveLength(1)
    expect(list[0].threadId).toBe('active-sess')
  })

  it('includes archived threads when includeArchived: true', () => {
    seedSession('active-sess')
    seedSession('archived-sess')
    updateThreadMeta(baseDir, 'archived-sess', { archived: true })
    const list = listThreads(baseDir, { includeArchived: true })
    expect(list).toHaveLength(2)
  })

  it('includes threads with archived: false when default filtering', () => {
    seedSession('explicit-active')
    updateThreadMeta(baseDir, 'explicit-active', { archived: false })
    const list = listThreads(baseDir)
    expect(list).toHaveLength(1)
  })

  it('can restore archived thread by setting archived: false', () => {
    seedSession('toggled-sess')
    updateThreadMeta(baseDir, 'toggled-sess', { archived: true })
    expect(listThreads(baseDir)).toHaveLength(0)
    updateThreadMeta(baseDir, 'toggled-sess', { archived: false })
    expect(listThreads(baseDir)).toHaveLength(1)
  })
})

// ─── fork metadata ────────────────────────────────────────────────────────────

describe('fork metadata', () => {
  it('stores and retrieves parentThreadId', () => {
    seedSession('parent-sess')
    seedSession('child-sess')
    updateThreadMeta(baseDir, 'child-sess', { parentThreadId: 'parent-sess' })
    const info = listThreads(baseDir).find(t => t.threadId === 'child-sess')
    expect(info?.meta?.parentThreadId).toBe('parent-sess')
  })

  it('stores and retrieves forkFromEntryId', () => {
    seedSession('parent-sess')
    seedSession('child-sess')
    updateThreadMeta(baseDir, 'child-sess', { parentThreadId: 'parent-sess', forkFromEntryId: 42 })
    const info = listThreads(baseDir).find(t => t.threadId === 'child-sess')
    expect(info?.meta?.forkFromEntryId).toBe(42)
  })

  it('root threads have no parentThreadId', () => {
    seedSession('root-sess')
    const info = listThreads(baseDir)[0]
    expect(info.meta?.parentThreadId).toBeUndefined()
  })
})

// ─── updateThreadMeta ────────────────────────────────────────────────────────

describe('updateThreadMeta', () => {
  it('merges new fields into existing meta', () => {
    createKernel({ dir: baseDir, threadId: 'upd-sess' })
    updateThreadMeta(baseDir, 'upd-sess', { title: 'Updated Title' })
    const info = listThreads(baseDir)[0]
    expect(info.meta?.title).toBe('Updated Title')
  })

  it('does not overwrite createdAt', () => {
    createKernel({ dir: baseDir, threadId: 'prot-sess' })
    const before = listThreads(baseDir)[0].meta!.createdAt

    // TypeScript prevents passing createdAt, but test that the value is intact after update
    updateThreadMeta(baseDir, 'prot-sess', { title: 'New Title' })
    const after = listThreads(baseDir)[0].meta!.createdAt

    expect(after).toBe(before)
  })

  it('is a no-op when the session does not have a meta.json', () => {
    mkdirSync(join(baseDir, 'no-meta-sess'), { recursive: true })
    expect(() => updateThreadMeta(baseDir, 'no-meta-sess', { title: 'x' })).not.toThrow()
  })

  it('overwrites an existing title when called twice', () => {
    createKernel({ dir: baseDir, threadId: 'retitle-sess', meta: { title: 'First' } })
    updateThreadMeta(baseDir, 'retitle-sess', { title: 'Second' })
    const info = listThreads(baseDir)[0]
    expect(info.meta?.title).toBe('Second')
  })
})
