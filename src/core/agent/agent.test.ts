import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Agent, createAgent } from './agent.js'
import { createKernel } from '../kernel/kernel.js'
import type {
  AgentEntry,
  AgentEvent,
  AgentOptions,
  LLMStepResult,
  LLMStreamEvent,
} from './types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUsage() {
  return {
    input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function okStep(overrides: Partial<LLMStepResult> = {}): LLMStepResult {
  return { text: 'reply', toolCalls: [], stopReason: 'stop', usage: makeUsage(), ...overrides }
}

function mockStreamFn(result: LLMStepResult = okStep(), events: LLMStreamEvent[] = []) {
  return vi.fn().mockImplementation(
    async (_msgs: unknown, _tools: unknown, onEvent: (e: LLMStreamEvent) => void) => {
      for (const e of events) onEvent(e)
      return result
    },
  )
}

function defaultOptions(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return { stream: mockStreamFn(), tools: [], maxSteps: 10, ...overrides }
}

function userEntry(text: string): AgentEntry {
  return { type: 'user', payload: { parts: [{ type: 'text', text }] } }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Agent', () => {
  describe('initial state', () => {
    it('isRunning is false before any prompt', () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      expect(agent.state.isRunning).toBe(false)
    })

    it('streamEntry is null before any prompt', () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      expect(agent.state.streamEntry).toBeNull()
    })

    it('pendingToolCalls is empty before any prompt', () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      expect(agent.state.pendingToolCalls.size).toBe(0)
    })

    it('error is null before any prompt', () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      expect(agent.state.error).toBeNull()
    })

    it('kernel getter returns the injected kernel', () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      expect(agent.kernel).toBe(kernel)
    })
  })

  describe('prompt()', () => {
    it('appends entry to kernel and starts the loop', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      agent.prompt(userEntry('hello'))
      await agent.waitForIdle()
      expect(kernel.read().length).toBeGreaterThan(0)
    })

    it('accepts an array of entries', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      agent.prompt([userEntry('a'), userEntry('b')])
      await agent.waitForIdle()
      // at least 2 user entries + 1 assistant
      expect(kernel.read().length).toBeGreaterThanOrEqual(3)
    })

    it('clears error state before running', async () => {
      const kernel = createKernel()
      const streamFn = vi.fn()
        .mockRejectedValueOnce(new Error('first error'))
        .mockResolvedValue(okStep())
      const agent = new Agent(kernel, defaultOptions({ stream: streamFn }))

      agent.prompt(userEntry('first'))
      await agent.waitForIdle()
      expect(agent.state.error).not.toBeNull()

      agent.prompt(userEntry('second'))
      await agent.waitForIdle()
      expect(agent.state.error).toBeNull()
    })

    it('throws if agent is already running', async () => {
      const kernel = createKernel()
      // Deferred promise: we control when the stream resolves
      let resolveStream!: (v: LLMStepResult) => void
      const stream = vi.fn().mockReturnValue(new Promise<LLMStepResult>(res => { resolveStream = res }))
      const agent = new Agent(kernel, defaultOptions({ stream }))
      agent.prompt(userEntry('first'))
      expect(() => agent.prompt(userEntry('second'))).toThrow('already running')
      resolveStream(okStep())
      await agent.waitForIdle()
    })
  })

  describe('continue()', () => {
    it('throws if agent is already running', async () => {
      const kernel = createKernel()
      let resolveStream!: (v: LLMStepResult) => void
      const stream = vi.fn().mockReturnValue(new Promise<LLMStepResult>(res => { resolveStream = res }))
      const agent = new Agent(kernel, defaultOptions({ stream }))
      agent.prompt(userEntry('go'))
      expect(() => agent.continue()).toThrow('already running')
      resolveStream(okStep())
      await agent.waitForIdle()
    })

    it('throws if there is no conversation to continue from', () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      expect(() => agent.continue()).toThrow('No conversation')
    })

    it('throws when last entry is a normal assistant stop and no queued messages', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      // Last entry is assistant with stopReason:'stop' — nothing queued
      expect(() => agent.continue()).toThrow('Nothing to continue')
    })

    it('continues after an error stopReason', async () => {
      const kernel = createKernel()
      const streamFn = vi.fn()
        .mockRejectedValueOnce(new Error('transient error'))
        .mockResolvedValue(okStep())
      const agent = new Agent(kernel, defaultOptions({ stream: streamFn }))
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      // Last assistant entry has stopReason:'error' → continue() is allowed
      expect(() => agent.continue()).not.toThrow()
      await agent.waitForIdle()
    })

    it('continues when follow-up messages are queued', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      agent.followUp(userEntry('follow up'))
      expect(() => agent.continue()).not.toThrow()
      await agent.waitForIdle()
    })
  })

  describe('subscribe()', () => {
    it('receives all agent events', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      const events: AgentEvent[] = []
      agent.subscribe(e => events.push(e))
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(events.some(e => e.type === 'agent_start')).toBe(true)
      expect(events.some(e => e.type === 'agent_end')).toBe(true)
    })

    it('unsubscribe stops receiving events', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      const events: AgentEvent[] = []
      const unsub = agent.subscribe(e => events.push(e))
      unsub()
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(events).toHaveLength(0)
    })

    it('multiple subscribers all receive events', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      const a: AgentEvent[] = []
      const b: AgentEvent[] = []
      agent.subscribe(e => a.push(e))
      agent.subscribe(e => b.push(e))
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(a.length).toBeGreaterThan(0)
      expect(a.length).toBe(b.length)
    })
  })

  describe('state during run', () => {
    it('isRunning is true while the loop is executing', async () => {
      const kernel = createKernel()
      let seenRunning = false
      const stream = vi.fn().mockImplementation(async () => {
        // Check state from within the stream call
        seenRunning = agent.state.isRunning
        return okStep()
      })
      const agent = new Agent(kernel, defaultOptions({ stream }))
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(seenRunning).toBe(true)
    })

    it('isRunning is false after waitForIdle()', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(agent.state.isRunning).toBe(false)
    })

    it('streamEntry is updated with text deltas during streaming', async () => {
      const kernel = createKernel()
      const streamEntries: Array<AgentEntry | null> = []
      const stream = vi.fn().mockImplementation(
        async (_m: unknown, _t: unknown, onEvent: (e: LLMStreamEvent) => void) => {
          onEvent({ type: 'text-delta', delta: 'Hello' })
          return okStep({ text: 'Hello' })
        },
      )
      const agent = new Agent(kernel, defaultOptions({ stream }))
      agent.subscribe(() => streamEntries.push(agent.state.streamEntry))
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      const withText = streamEntries.filter(
        e => e?.type === 'assistant' && (e.payload as { text: string }).text.length > 0,
      )
      expect(withText.length).toBeGreaterThan(0)
    })

    it('pendingToolCalls is populated when tool_call event fires', async () => {
      const kernel = createKernel()
      // Capture state.pendingToolCalls inside the subscriber, which runs after
      // _handleEvent has already updated the set — correct timing.
      const seenPending: string[][] = []
      let callCount = 0

      const stream = vi.fn().mockImplementation(
        async (_m: unknown, _t: unknown, onEvent: (e: LLMStreamEvent) => void) => {
          callCount++
          if (callCount === 1) {
            onEvent({ type: 'tool-call', toolCallId: 'c1', toolName: 'myTool', input: {} })
            return okStep({
              toolCalls: [{ toolCallId: 'c1', toolName: 'myTool', input: {} }],
              stopReason: 'tool_use',
            })
          }
          return okStep()
        },
      )

      const tool = {
        name: 'myTool',
        description: 'test',
        execute: vi.fn().mockResolvedValue({ content: 'done', isError: false }),
      }

      const agent = new Agent(kernel, defaultOptions({ stream, tools: [tool] }))
      // _handleEvent runs before listeners, so state is already updated when we read it here
      agent.subscribe(e => {
        if (e.type === 'tool_call') {
          seenPending.push([...agent.state.pendingToolCalls])
        }
      })
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(seenPending.some(s => s.includes('c1'))).toBe(true)
    })

    it('error is set on state after a stream error', async () => {
      const kernel = createKernel()
      const stream = vi.fn().mockRejectedValue(new Error('oh no'))
      const agent = new Agent(kernel, defaultOptions({ stream }))
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(agent.state.error).toBe('oh no')
    })
  })

  describe('abort()', () => {
    it('stops the running loop', async () => {
      const kernel = createKernel()
      // The agent may call abort() before or after the stream starts, so check
      // signal.aborted immediately AND listen for the event.
      const stream = vi.fn().mockImplementation(async (_m: unknown, _t: unknown, _onEvent: unknown, signal?: AbortSignal) => {
        return new Promise<LLMStepResult>((_, reject) => {
          const doAbort = () => {
            const err = new Error('AbortError')
            err.name = 'AbortError'
            reject(err)
          }
          if (signal?.aborted) { doAbort(); return }
          signal?.addEventListener('abort', doAbort)
        })
      })
      const agent = new Agent(kernel, defaultOptions({ stream }))
      agent.prompt(userEntry('go'))
      agent.abort()
      await agent.waitForIdle()
      expect(agent.state.isRunning).toBe(false)
    })

    it('abort() is a no-op when not running', () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      expect(() => agent.abort()).not.toThrow()
    })
  })

  describe('reset()', () => {
    it('clears steering and follow-up queues', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      agent.steer(userEntry('steer'))
      agent.followUp(userEntry('follow'))
      agent.reset()
      // After reset, queues are empty — a normal prompt/continue won't process them
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      // Just verify it ran without issues and queues were drained
      expect(agent.state.error).toBeNull()
    })

    it('clears error state', async () => {
      const kernel = createKernel()
      const stream = vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(okStep())
      const agent = new Agent(kernel, defaultOptions({ stream }))
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(agent.state.error).not.toBeNull()
      agent.reset()
      expect(agent.state.error).toBeNull()
    })

    it('throws if called while running', async () => {
      const kernel = createKernel()
      let resolveStream!: (v: LLMStepResult) => void
      const stream = vi.fn().mockReturnValue(new Promise<LLMStepResult>(res => { resolveStream = res }))
      const agent = new Agent(kernel, defaultOptions({ stream }))
      agent.prompt(userEntry('hi'))
      expect(() => agent.reset()).toThrow('Cannot reset while running')
      resolveStream(okStep())
      await agent.waitForIdle()
    })
  })

  describe('steer()', () => {
    it('queues a steering entry consumed on next loop iteration', async () => {
      const kernel = createKernel()
      let callCount = 0
      const stream = vi.fn().mockImplementation(async () => {
        callCount++
        return okStep()
      })
      const agent = new Agent(kernel, defaultOptions({ stream }))
      // Queue steering before prompt so it's picked up at loop start
      agent.steer(userEntry('steer me'))
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      // Stream called at least once; steering entry should be in kernel
      const entries = kernel.read()
      expect(entries.some(
        e => e.type === 'user' && (e.payload as { parts: Array<{ text: string }> }).parts[0].text === 'steer me',
      )).toBe(true)
    })

    it('one-at-a-time mode drains one steering entry per iteration', async () => {
      const kernel = createKernel()
      const drained: string[] = []
      let callCount = 0

      const stream = vi.fn().mockImplementation(async () => {
        callCount++
        return okStep()
      })

      const agent = new Agent(kernel, defaultOptions({ stream, steeringMode: 'one-at-a-time' }))
      agent.steer(userEntry('steer-1'))
      agent.steer(userEntry('steer-2'))
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()

      const steerEntries = kernel.read().filter(
        e => e.type === 'user' && ['steer-1', 'steer-2'].includes(
          (e.payload as { parts: Array<{ text: string }> }).parts[0].text,
        ),
      )
      // Both should be processed eventually
      expect(steerEntries.length).toBe(2)
    })

    it('all mode drains all steering entries at once', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions({ steeringMode: 'all' }))
      agent.steer(userEntry('s1'))
      agent.steer(userEntry('s2'))
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      const steerEntries = kernel.read().filter(
        e => e.type === 'user' && ['s1', 's2'].includes(
          (e.payload as { parts: Array<{ text: string }> }).parts[0].text,
        ),
      )
      expect(steerEntries.length).toBe(2)
    })
  })

  describe('followUp()', () => {
    it('follow-up entry triggers a second run after the first completes', async () => {
      const kernel = createKernel()
      let callCount = 0
      const stream = vi.fn().mockImplementation(async () => {
        callCount++
        return okStep()
      })
      const agent = new Agent(kernel, defaultOptions({ stream }))
      agent.followUp(userEntry('follow up'))
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(callCount).toBeGreaterThanOrEqual(2)
    })
  })

  describe('mutators', () => {
    it('setStream() replaces the stream function', async () => {
      const kernel = createKernel()
      const stream1 = mockStreamFn()
      const stream2 = mockStreamFn()
      const agent = new Agent(kernel, defaultOptions({ stream: stream1 }))
      agent.setStream(stream2)
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(stream1).not.toHaveBeenCalled()
      expect(stream2).toHaveBeenCalled()
    })

    it('setMaxSteps() limits turn count', async () => {
      const kernel = createKernel()
      // Always returns tool calls so the loop would go on forever
      const execute = vi.fn().mockResolvedValue({ content: 'done', isError: false })
      const tool = { name: 'loop', description: 'loops', execute }
      const stream = vi.fn().mockResolvedValue(
        okStep({ toolCalls: [{ toolCallId: 'c1', toolName: 'loop', input: {} }], stopReason: 'tool_use' }),
      )
      const agent = new Agent(kernel, defaultOptions({ stream, tools: [tool], maxSteps: 10 }))
      agent.setMaxSteps(2)
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(stream.mock.calls.length).toBeLessThanOrEqual(2)
    })

    it('setTools() replaces the tool list', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions({ tools: [] }))
      const newTool = {
        name: 'newTool',
        description: 'new',
        execute: vi.fn().mockResolvedValue({ content: 'ok', isError: false }),
      }
      agent.setTools([newTool])
      // Verify via stream call receiving updated tools list
      let receivedTools: unknown[] = []
      agent.setStream(vi.fn().mockImplementation(async (_m: unknown, tools: unknown[]) => {
        receivedTools = tools
        return okStep()
      }))
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect((receivedTools as Array<{ name: string }>).some(t => t.name === 'newTool')).toBe(true)
    })
  })

  describe('waitForIdle()', () => {
    it('resolves immediately when not running', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      await expect(agent.waitForIdle()).resolves.toBeUndefined()
    })

    it('resolves after the loop finishes', async () => {
      const kernel = createKernel()
      const agent = new Agent(kernel, defaultOptions())
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(agent.state.isRunning).toBe(false)
    })
  })

  describe('createAgent()', () => {
    it('creates an Agent with an in-memory kernel when no session is provided', async () => {
      const agent = createAgent(defaultOptions())
      expect(agent).toBeInstanceOf(Agent)
      agent.prompt(userEntry('hi'))
      await agent.waitForIdle()
      expect(agent.state.isRunning).toBe(false)
    })
  })
})
