import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createKernel } from './kernel.js'
import type { AgentEntry } from './types.js'

// Temp dirs created during file-persistence tests; cleaned up after each test.
const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

function makeTmpDir(): string {
  const dir = mkdtempSync(tmpdir() + '/kernel-test-')
  tmpDirs.push(dir)
  return dir
}

// Helper to build a zero-cost Usage object
function makeUsage(input = 0, output = 0) {
  return {
    input,
    output,
    cacheRead:  0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function userEntry(text: string): AgentEntry {
  return { type: 'user', payload: { parts: [{ type: 'text', text }] } }
}

function assistantEntry(text: string, inputTokens = 0): AgentEntry {
  return {
    type:    'assistant',
    payload: { text, toolCalls: [], stopReason: 'stop' },
    usage:   makeUsage(inputTokens),
  }
}

describe('Kernel (in-memory)', () => {
  it('starts empty', () => {
    const k = createKernel()
    expect(k.read()).toEqual([])
    expect(k.leafId).toBeNull()
    expect(k.peek()).toBeNull()
  })

  it('append() adds an entry and updates leafId', () => {
    const k = createKernel()
    const result = k.append(userEntry('hello'))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error()
    expect(result.id).toBe(0)
    expect(k.leafId).toBe(0)
  })

  it('read() returns entries in chronological order', () => {
    const k = createKernel()
    k.append(userEntry('a'))
    k.append(assistantEntry('b'))
    k.append(userEntry('c'))

    const entries = k.read()
    expect(entries).toHaveLength(3)
    expect(entries[0].type).toBe('user')
    expect(entries[1].type).toBe('assistant')
    expect(entries[2].type).toBe('user')
  })

  it('peek() returns the latest stored entry', () => {
    const k = createKernel()
    k.append(userEntry('first'))
    k.append(assistantEntry('second'))
    const top = k.peek()
    expect(top?.type).toBe('assistant')
  })

  it('branch() switches the current leaf', () => {
    const k = createKernel()
    const r0 = k.append(userEntry('msg0'))
    if (!r0.ok) throw new Error()
    k.append(userEntry('msg1'))

    // Branch back to first entry
    k.branch(r0.id)
    expect(k.leafId).toBe(r0.id)
    const entries = k.read()
    expect(entries).toHaveLength(1)
  })

  it('branch() throws for unknown id', () => {
    const k = createKernel()
    expect(() => k.branch(999)).toThrow()
  })

  it('contextSize is 0 when no assistant entry exists', () => {
    const k = createKernel()
    k.append(userEntry('hi'))
    expect(k.contextSize).toBe(0)
  })

  it('contextSize reflects last assistant entry input tokens', () => {
    const k = createKernel()
    k.append(userEntry('hi'))
    k.append(assistantEntry('hello', 123))
    expect(k.contextSize).toBe(123)
  })

  it('budget.used reflects last assistant input tokens', () => {
    const k = createKernel()
    k.append(assistantEntry('x', 50))
    expect(k.budget.used).toBe(50)
  })

  it('budget.set() updates the token limit', () => {
    const k = createKernel()
    k.budget.set(1000)
    expect(k.budget.limit).toBe(1000)
  })

  describe('buildMessages()', () => {
    it('single text user entry → string shorthand', () => {
      const k = createKernel()
      k.append(userEntry('hello'))
      const msgs = k.buildMessages()
      expect(msgs).toEqual([{ role: 'user', content: 'hello' }])
    })

    it('multi-part user entry → array content', () => {
      const k = createKernel()
      k.append({
        type: 'user',
        payload: {
          parts: [
            { type: 'text', text: 'look at this' },
            { type: 'text', text: 'and this' },
          ],
        },
      })
      const msgs = k.buildMessages()
      expect(msgs[0].role).toBe('user')
      expect(Array.isArray(msgs[0].content)).toBe(true)
    })

    it('assistant entry with no tools/reasoning → string content', () => {
      const k = createKernel()
      k.append(assistantEntry('I am Claude'))
      const msgs = k.buildMessages()
      expect(msgs).toEqual([{ role: 'assistant', content: 'I am Claude' }])
    })

    it('assistant entry with tool calls → array content', () => {
      const k = createKernel()
      k.append({
        type: 'assistant',
        payload: {
          text:      '',
          toolCalls: [{ toolCallId: 'c1', toolName: 'search', input: { q: 'hi' } }],
          stopReason: 'tool_use',
        },
      })
      const msgs = k.buildMessages()
      expect(msgs[0].role).toBe('assistant')
      expect(Array.isArray(msgs[0].content)).toBe(true)
      const parts = msgs[0].content as Array<{ type: string }>
      expect(parts.some(p => p.type === 'tool-call')).toBe(true)
    })

    it('assistant entry with reasoning → array content', () => {
      const k = createKernel()
      k.append({
        type: 'assistant',
        payload: {
          text:      'answer',
          reasoning: 'let me think',
          toolCalls: [],
          stopReason: 'stop',
        },
      })
      const msgs = k.buildMessages()
      expect(Array.isArray(msgs[0].content)).toBe(true)
      const parts = msgs[0].content as Array<{ type: string }>
      expect(parts.some(p => p.type === 'reasoning')).toBe(true)
    })

    it('tool_result entry → role:tool message', () => {
      const k = createKernel()
      k.append({
        type:    'tool_result',
        payload: { toolCallId: 'c1', toolName: 'search', content: 'result', isError: false },
      })
      const msgs = k.buildMessages()
      expect(msgs[0].role).toBe('tool')
    })

    it('summary entry → user message with Context Summary prefix', () => {
      const k = createKernel()
      k.append({ type: 'summary', payload: { text: 'Prior context...' } })
      const msgs = k.buildMessages()
      expect(msgs[0].role).toBe('user')
      expect((msgs[0].content as string)).toContain('[Context Summary]')
    })
  })

  describe('compact()', () => {
    it('replaces a range of entries with a summary entry', () => {
      const k = createKernel()
      k.append(userEntry('msg0'))
      k.append(assistantEntry('msg1'))
      k.append(userEntry('msg2'))

      const r0 = k.read()[0]
      const r2 = k.read()[2]

      const result = k.compact(r0.id, r2.id, 'Summary of msgs 0-2')
      expect(result.ok).toBe(true)

      const entries = k.read()
      // Only the compaction summary entry should remain
      expect(entries).toHaveLength(1)
      expect(entries[0].type).toBe('summary')
    })

    it('compact summary appears in buildMessages()', () => {
      const k = createKernel()
      k.append(userEntry('hi'))
      k.append(assistantEntry('hello'))
      const r0 = k.read()[0]
      const r1 = k.read()[1]
      k.compact(r0.id, r1.id, 'Summarized')
      const msgs = k.buildMessages()
      expect(msgs.some(m => (m.content as string).includes('[Context Summary]'))).toBe(true)
    })
  })

  describe('readLog() — file persistence', () => {
    it('returns empty array in in-memory mode', () => {
      const k = createKernel()
      expect(k.readLog()).toEqual([])
    })

    it('persists appended entries to log.jsonl and readLog() returns them', () => {
      const dir = makeTmpDir()
      const k = createKernel({ dir, sessionId: 'sess1' })
      k.append(userEntry('hello'))
      k.append(assistantEntry('world'))

      const log = k.readLog()
      expect(log).toHaveLength(2)
      expect(log[0].type).toBe('user')
      expect(log[1].type).toBe('assistant')
    })

    it('readLog() survives compaction — still shows full history', () => {
      const dir = makeTmpDir()
      const k = createKernel({ dir, sessionId: 'sess2' })
      k.append(userEntry('a'))
      k.append(assistantEntry('b'))
      const r0 = k.read()[0]
      const r1 = k.read()[1]
      k.compact(r0.id, r1.id, 'Compacted')

      const log = k.readLog()
      // log.jsonl contains original entries + the summary divider
      expect(log.some(e => e.type === 'user')).toBe(true)
      expect(log.some(e => e.type === 'assistant')).toBe(true)
    })

    it('kernel state is restored from kernel.jsonl on construction', () => {
      const dir = makeTmpDir()
      const sessionId = 'sess3'

      // Write entries with kernel1
      const k1 = createKernel({ dir, sessionId })
      k1.append(userEntry('persisted'))
      k1.append(assistantEntry('yes', 42))

      // Re-create kernel from the same session — should load from file
      const k2 = createKernel({ dir, sessionId })
      const entries = k2.read()
      expect(entries).toHaveLength(2)
      expect(entries[0].type).toBe('user')
      expect(k2.contextSize).toBe(42)
    })
  })
})
