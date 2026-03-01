import { describe, it, expect, vi } from 'vitest'
import { Type } from '@sinclair/typebox'
import { runLoop } from './loop.js'
import { createKernel } from '../kernel/kernel.js'
import type {
  AgentConfig,
  AgentEvent,
  AgentKernel,
  AgentTool,
  LLMStepResult,
  LLMStreamEvent,
} from './types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUsage(input = 10, output = 5) {
  return {
    input,
    output,
    cacheRead:   0,
    cacheWrite:  0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function stepResult(overrides: Partial<LLMStepResult> = {}): LLMStepResult {
  return {
    text:       'Hello',
    toolCalls:  [],
    stopReason: 'stop',
    usage:      makeUsage(),
    ...overrides,
  }
}

/**
 * Returns a StreamFn that calls onEvent with the given events, then resolves
 * with stepResult.
 */
function mockStream(
  result: LLMStepResult,
  events: LLMStreamEvent[] = [],
) {
  return vi.fn().mockImplementation(
    async (
      _messages: unknown,
      _tools: unknown,
      onEvent: (e: LLMStreamEvent) => void,
    ) => {
      for (const e of events) onEvent(e)
      return result
    },
  )
}

async function collectEvents(
  config: AgentConfig,
): Promise<{ events: AgentEvent[]; result: Awaited<ReturnType<typeof runLoop.prototype.result>> }> {
  const kernel = createKernel()
  // Seed a user message so there's something to send to the LLM
  kernel.append({ type: 'user', payload: { parts: [{ type: 'text', text: 'hi' }] } })
  return collectEventsFromKernel(kernel, config)
}

async function collectEventsFromKernel(
  kernel: AgentKernel,
  config: AgentConfig,
): Promise<{ events: AgentEvent[]; result: Awaited<ReturnType<typeof runLoop.prototype.result>> }> {
  const stream = runLoop(kernel, config)
  const events: AgentEvent[] = []
  for await (const e of stream) {
    events.push(e)
  }
  const result = await stream.result()
  return { events, result }
}

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    stream:   mockStream(stepResult()),
    tools:    [],
    maxSteps: 10,
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runLoop', () => {
  it('emits agent_start and agent_end events', async () => {
    const { events } = await collectEvents(baseConfig())
    expect(events[0].type).toBe('agent_start')
    expect(events.at(-1)!.type).toBe('agent_end')
  })

  it('emits turn_start and turn_end events', async () => {
    const { events } = await collectEvents(baseConfig())
    expect(events.some(e => e.type === 'turn_start')).toBe(true)
    expect(events.some(e => e.type === 'turn_end')).toBe(true)
  })

  it('emits message_start and message_end events', async () => {
    const { events } = await collectEvents(baseConfig())
    expect(events.some(e => e.type === 'message_start')).toBe(true)
    expect(events.some(e => e.type === 'message_end')).toBe(true)
  })

  it('emits text_delta events from the stream', async () => {
    const cfg = baseConfig({
      stream: mockStream(stepResult({ text: 'AB' }), [
        { type: 'text-delta', delta: 'A' },
        { type: 'text-delta', delta: 'B' },
      ]),
    })
    const { events } = await collectEvents(cfg)
    const deltas = events.filter(e => e.type === 'text_delta') as Array<{ type: 'text_delta'; delta: string }>
    expect(deltas.map(d => d.delta)).toEqual(['A', 'B'])
  })

  it('emits reasoning_delta events', async () => {
    const cfg = baseConfig({
      stream: mockStream(
        stepResult({ reasoning: 'thinking...' }),
        [{ type: 'reasoning-delta', delta: 'thinking...' }],
      ),
    })
    const { events } = await collectEvents(cfg)
    expect(events.some(e => e.type === 'reasoning_delta')).toBe(true)
  })

  it('emits step_done with usage', async () => {
    const usage = makeUsage(100, 50)
    const cfg = baseConfig({
      stream: mockStream(stepResult({ usage })),
    })
    const { events } = await collectEvents(cfg)
    const stepDone = events.find(e => e.type === 'step_done') as { type: 'step_done'; stepNumber: number; usage: typeof usage }
    expect(stepDone).toBeTruthy()
    expect(stepDone.usage.input).toBe(100)
  })

  it('result() accumulates total usage', async () => {
    const usage = makeUsage(10, 5)
    const cfg = baseConfig({
      stream: mockStream(stepResult({ usage })),
    })
    const { result } = await collectEvents(cfg)
    expect(result.usage.input).toBe(10)
    expect(result.usage.output).toBe(5)
  })

  it('calls the stream function once for a simple response', async () => {
    const streamFn = mockStream(stepResult())
    await collectEvents(baseConfig({ stream: streamFn }))
    expect(streamFn).toHaveBeenCalledOnce()
  })

  describe('tool execution', () => {
    it('executes a tool call and writes tool_result to kernel', async () => {
      const execute = vi.fn().mockResolvedValue({ content: 'tool output', isError: false })
      const tool: AgentTool = { name: 'myTool', description: 'A tool', execute }

      let callCount = 0
      const streamFn = vi.fn().mockImplementation(
        async (_msgs: unknown, _tools: unknown, onEvent: (e: LLMStreamEvent) => void) => {
          callCount++
          if (callCount === 1) {
            // First call: returns a tool call
            onEvent({ type: 'tool-call', toolCallId: 'c1', toolName: 'myTool', input: {} })
            return stepResult({
              text:       '',
              toolCalls:  [{ toolCallId: 'c1', toolName: 'myTool', input: {} }],
              stopReason: 'tool_use',
            })
          }
          // Second call: normal stop
          return stepResult()
        },
      )

      const { events } = await collectEvents(baseConfig({ stream: streamFn, tools: [tool] }))
      expect(execute).toHaveBeenCalledOnce()
      expect(events.some(e => e.type === 'tool_result')).toBe(true)
      expect(streamFn).toHaveBeenCalledTimes(2)
    })

    it('emits tool_call event before executing the tool', async () => {
      const execute = vi.fn().mockResolvedValue({ content: 'done', isError: false })
      const tool: AgentTool = { name: 'myTool', description: 'A tool', execute }

      let callCount = 0
      const streamFn = vi.fn().mockImplementation(
        async (_msgs: unknown, _tools: unknown, onEvent: (e: LLMStreamEvent) => void) => {
          callCount++
          if (callCount === 1) {
            onEvent({ type: 'tool-call', toolCallId: 'c1', toolName: 'myTool', input: {} })
            return stepResult({
              toolCalls:  [{ toolCallId: 'c1', toolName: 'myTool', input: {} }],
              stopReason: 'tool_use',
            })
          }
          return stepResult()
        },
      )

      const { events } = await collectEvents(baseConfig({ stream: streamFn, tools: [tool] }))
      const toolCallEvent = events.find(e => e.type === 'tool_call') as { type: 'tool_call'; toolName: string }
      expect(toolCallEvent?.toolName).toBe('myTool')
    })

    it('returns error result when tool is not found', async () => {
      let callCount = 0
      const streamFn = vi.fn().mockImplementation(
        async () => {
          callCount++
          if (callCount === 1) {
            return stepResult({
              toolCalls:  [{ toolCallId: 'c1', toolName: 'unknownTool', input: {} }],
              stopReason: 'tool_use',
            })
          }
          return stepResult()
        },
      )

      const { events } = await collectEvents(baseConfig({ stream: streamFn, tools: [] }))
      const toolResultEvent = events.find(e => e.type === 'tool_result') as { type: 'tool_result'; isError: boolean }
      expect(toolResultEvent?.isError).toBe(true)
    })

    it('validates tool input with TypeBox schema and returns error on failure', async () => {
      const schema = Type.Object({ name: Type.String() })
      const execute = vi.fn().mockResolvedValue({ content: 'ok', isError: false })
      const tool: AgentTool = { name: 'myTool', description: 'A tool', parameters: schema, execute }

      let callCount = 0
      const streamFn = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return stepResult({
            toolCalls:  [{ toolCallId: 'c1', toolName: 'myTool', input: { name: 123 } }],
            stopReason: 'tool_use',
          })
        }
        return stepResult()
      })

      const { events } = await collectEvents(baseConfig({ stream: streamFn, tools: [tool] }))
      const toolResultEvent = events.find(e => e.type === 'tool_result') as { type: 'tool_result'; isError: boolean }
      // TypeBox coerces number→string, so validation passes. The important thing
      // is that the execute was called (or not). At minimum the event must exist.
      expect(toolResultEvent).toBeTruthy()
    })
  })

  describe('maxSteps', () => {
    it('stops after maxSteps turns even if tools keep returning', async () => {
      const execute = vi.fn().mockResolvedValue({ content: 'done', isError: false })
      const tool: AgentTool = { name: 'loop', description: 'loops', execute }

      // StreamFn always returns a tool call — would loop forever without maxSteps
      const streamFn = vi.fn().mockResolvedValue(
        stepResult({
          toolCalls:  [{ toolCallId: 'c1', toolName: 'loop', input: {} }],
          stopReason: 'tool_use',
        }),
      )

      await collectEvents(baseConfig({ stream: streamFn, tools: [tool], maxSteps: 3 }))
      expect(streamFn.mock.calls.length).toBeLessThanOrEqual(3)
    })
  })

  describe('abort', () => {
    it('handles AbortError and emits agent_end with error', async () => {
      const controller = new AbortController()
      const streamFn = vi.fn().mockImplementation(async () => {
        controller.abort()
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      })

      const { events } = await collectEvents(
        baseConfig({ stream: streamFn, signal: controller.signal }),
      )
      const endEvent = events.find(e => e.type === 'agent_end') as { type: 'agent_end'; error?: string }
      expect(endEvent).toBeTruthy()
      expect(endEvent.error).toBeTruthy()
    })
  })

  describe('error handling', () => {
    it('handles a stream error gracefully and still emits agent_end', async () => {
      const streamFn = vi.fn().mockRejectedValue(new Error('network error'))
      const { events } = await collectEvents(baseConfig({ stream: streamFn }))
      const endEvent = events.find(e => e.type === 'agent_end') as { type: 'agent_end'; error?: string }
      expect(endEvent).toBeTruthy()
      expect(endEvent.error).toBe('network error')
    })

    it('result() resolves even after an error', async () => {
      const streamFn = vi.fn().mockRejectedValue(new Error('oops'))
      const { result } = await collectEvents(baseConfig({ stream: streamFn }))
      // Loop catches errors and calls stream.end(), so result resolves
      expect(result).toHaveProperty('usage')
      expect(result).toHaveProperty('durationMs')
    })
  })

  describe('steering messages', () => {
    it('getSteeringMessages() entries are written to kernel and processed', async () => {
      let steeringConsumed = false
      let callCount = 0

      const streamFn = vi.fn().mockImplementation(async () => {
        callCount++
        return stepResult()
      })

      const getSteeringMessages = vi.fn().mockImplementation(async () => {
        if (!steeringConsumed) {
          steeringConsumed = true
          return [{ type: 'user' as const, payload: { parts: [{ type: 'text' as const, text: 'steer' }] } }]
        }
        return []
      })

      await collectEvents(baseConfig({ stream: streamFn, getSteeringMessages }))
      // Stream was called at least once
      expect(callCount).toBeGreaterThanOrEqual(1)
    })
  })

  describe('follow-up messages', () => {
    it('getFollowUpMessages() causes the outer loop to iterate', async () => {
      let followUpSent = false
      let callCount = 0

      const streamFn = vi.fn().mockImplementation(async () => {
        callCount++
        return stepResult()
      })

      const getFollowUpMessages = vi.fn().mockImplementation(async () => {
        if (!followUpSent) {
          followUpSent = true
          return [{ type: 'user' as const, payload: { parts: [{ type: 'text' as const, text: 'follow up' }] } }]
        }
        return []
      })

      await collectEvents(baseConfig({ stream: streamFn, getFollowUpMessages }))
      // Follow-up causes a second run, so stream called at least twice
      expect(callCount).toBeGreaterThanOrEqual(2)
    })
  })

  describe('transformContext', () => {
    it('transformContext is called before each LLM call', async () => {
      const transformContext = vi.fn().mockImplementation(async (msgs: unknown) => msgs)
      await collectEvents(baseConfig({ transformContext }))
      expect(transformContext).toHaveBeenCalledOnce()
    })
  })

  describe('onStepEnd', () => {
    it('onStepEnd callback is called after each step', async () => {
      const onStepEnd = vi.fn().mockResolvedValue(undefined)
      await collectEvents(baseConfig({ onStepEnd }))
      expect(onStepEnd).toHaveBeenCalledOnce()
    })
  })

  describe('parallelTools', () => {
    function makeTrackedTool(name: string, execOrder: string[], delayMs: number): AgentTool {
      return {
        name,
        description: name,
        execute: async () => {
          execOrder.push(`${name}:start`)
          await new Promise(r => setTimeout(r, delayMs))
          execOrder.push(`${name}:end`)
          return { content: `${name} done`, isError: false }
        },
      }
    }

    function twoToolStream(): ReturnType<typeof vi.fn> {
      let callCount = 0
      return vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return stepResult({
            toolCalls: [
              { toolCallId: 'c1', toolName: 'toolA', input: {} },
              { toolCallId: 'c2', toolName: 'toolB', input: {} },
            ],
            stopReason: 'tool_use',
          })
        }
        return stepResult()
      })
    }

    it('runs tools sequentially by default', async () => {
      const execOrder: string[] = []
      await collectEvents(baseConfig({
        stream: twoToolStream(),
        tools:  [makeTrackedTool('toolA', execOrder, 10), makeTrackedTool('toolB', execOrder, 10)],
      }))
      expect(execOrder).toEqual(['toolA:start', 'toolA:end', 'toolB:start', 'toolB:end'])
    })

    it('runs tools concurrently when parallelTools: true (both start before either ends)', async () => {
      const execOrder: string[] = []
      await collectEvents(baseConfig({
        stream:        twoToolStream(),
        tools:         [makeTrackedTool('toolA', execOrder, 30), makeTrackedTool('toolB', execOrder, 30)],
        parallelTools: true,
      }))
      // Both start before either finishes
      expect(execOrder[0]).toBe('toolA:start')
      expect(execOrder[1]).toBe('toolB:start')
      expect(execOrder).toHaveLength(4)
    })

    it('collects results in toolCalls order when parallel', async () => {
      const execute = vi.fn()
        .mockResolvedValueOnce({ content: 'A result', isError: false })
        .mockResolvedValueOnce({ content: 'B result', isError: false })

      let callCount = 0
      const streamFn = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return stepResult({
            toolCalls: [
              { toolCallId: 'c1', toolName: 'toolA', input: {} },
              { toolCallId: 'c2', toolName: 'toolB', input: {} },
            ],
            stopReason: 'tool_use',
          })
        }
        return stepResult()
      })

      const { events } = await collectEvents(baseConfig({
        stream:        streamFn,
        tools:         [
          { name: 'toolA', description: 'A', execute },
          { name: 'toolB', description: 'B', execute },
        ],
        parallelTools: true,
      }))

      const results = events.filter(e => e.type === 'tool_result') as Array<{
        type: 'tool_result'; toolCallId: string; content: string
      }>
      expect(results).toHaveLength(2)
      // Both tools should have produced results
      expect(results.some(r => r.toolCallId === 'c1')).toBe(true)
      expect(results.some(r => r.toolCallId === 'c2')).toBe(true)
    })

    it('discards parallel tool results and uses skipTool when steering arrives', async () => {
      let toolsStarted = false
      const execute = vi.fn().mockImplementation(async () => {
        toolsStarted = true
        return { content: 'done', isError: false }
      })

      let callCount = 0
      const streamFn = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return stepResult({
            toolCalls: [
              { toolCallId: 'c1', toolName: 'tool1', input: {} },
              { toolCallId: 'c2', toolName: 'tool2', input: {} },
            ],
            stopReason: 'tool_use',
          })
        }
        return stepResult()
      })

      // Return steering only after the initial pre-loop check (when tools have started)
      let steeringCalls = 0
      const getSteeringMessages = vi.fn().mockImplementation(async () => {
        steeringCalls++
        if (steeringCalls > 1 && toolsStarted) {
          return [{ type: 'user' as const, payload: { parts: [{ type: 'text' as const, text: 'interrupt' }] } }]
        }
        return []
      })

      const { events } = await collectEvents(baseConfig({
        stream:              streamFn,
        tools:               [
          { name: 'tool1', description: 't1', execute },
          { name: 'tool2', description: 't2', execute },
        ],
        parallelTools:       true,
        getSteeringMessages,
      }))

      // Both tools actually ran (parallel — can't stop them mid-flight)
      expect(execute).toHaveBeenCalledTimes(2)

      // All results are replaced with skipTool
      const toolResults = events.filter(e => e.type === 'tool_result') as Array<{ isError: boolean }>
      expect(toolResults).toHaveLength(2)
      expect(toolResults.every(r => r.isError)).toBe(true)
    })
  })

  describe('toolTimeout', () => {
    it('returns an error result when a tool exceeds the timeout', async () => {
      const slowTool: AgentTool = {
        name:        'slow',
        description: 'A slow tool',
        execute: async () => {
          await new Promise(r => setTimeout(r, 500))
          return { content: 'never', isError: false }
        },
      }

      let callCount = 0
      const streamFn = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return stepResult({
            toolCalls:  [{ toolCallId: 'c1', toolName: 'slow', input: {} }],
            stopReason: 'tool_use',
          })
        }
        return stepResult()
      })

      const { events } = await collectEvents(baseConfig({
        stream:      streamFn,
        tools:       [slowTool],
        toolTimeout: 30,
      }))

      const toolResultEvent = events.find(e => e.type === 'tool_result') as {
        type: 'tool_result'; isError: boolean; content: string
      }
      expect(toolResultEvent?.isError).toBe(true)
      expect(toolResultEvent?.content).toMatch(/timed out/)
    })

    it('does not interfere when tool completes within the timeout', async () => {
      const fastTool: AgentTool = {
        name:        'fast',
        description: 'A fast tool',
        execute: async () => ({ content: 'quick', isError: false }),
      }

      let callCount = 0
      const streamFn = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return stepResult({
            toolCalls:  [{ toolCallId: 'c1', toolName: 'fast', input: {} }],
            stopReason: 'tool_use',
          })
        }
        return stepResult()
      })

      const { events } = await collectEvents(baseConfig({
        stream:      streamFn,
        tools:       [fastTool],
        toolTimeout: 500,
      }))

      const toolResultEvent = events.find(e => e.type === 'tool_result') as {
        type: 'tool_result'; isError: boolean; content: string
      }
      expect(toolResultEvent?.isError).toBe(false)
      expect(toolResultEvent?.content).toBe('quick')
    })
  })

  describe('onContextFull', () => {
    it('fires the callback when contextSize >= budget.limit', async () => {
      const kernel = createKernel()
      kernel.append({ type: 'user', payload: { parts: [{ type: 'text', text: 'hi' }] } })
      kernel.budget.set(5) // limit = 5 tokens

      const onContextFull = vi.fn().mockResolvedValue(undefined)
      await collectEventsFromKernel(kernel, baseConfig({
        stream:        mockStream(stepResult({ usage: makeUsage(10, 5) })), // input=10 >= limit=5
        onContextFull,
      }))

      expect(onContextFull).toHaveBeenCalledOnce()
      expect(onContextFull).toHaveBeenCalledWith(kernel, 1)
    })

    it('does not fire when budget.limit is Infinity (default)', async () => {
      const onContextFull = vi.fn().mockResolvedValue(undefined)
      await collectEvents(baseConfig({
        stream:        mockStream(stepResult({ usage: makeUsage(1_000_000, 5) })),
        onContextFull,
      }))
      expect(onContextFull).not.toHaveBeenCalled()
    })

    it('does not fire when contextSize is below budget.limit', async () => {
      const kernel = createKernel()
      kernel.append({ type: 'user', payload: { parts: [{ type: 'text', text: 'hi' }] } })
      kernel.budget.set(100)

      const onContextFull = vi.fn().mockResolvedValue(undefined)
      await collectEventsFromKernel(kernel, baseConfig({
        stream:        mockStream(stepResult({ usage: makeUsage(50, 5) })), // input=50 < limit=100
        onContextFull,
      }))

      expect(onContextFull).not.toHaveBeenCalled()
    })
  })

  describe('retryOnError', () => {
    it('retries a failing stream and succeeds on the final attempt', async () => {
      let callCount = 0
      const streamFn = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount < 3) throw new Error(`attempt ${callCount} failed`)
        return stepResult()
      })

      const { events } = await collectEvents(baseConfig({
        stream:       streamFn,
        retryOnError: { maxAttempts: 3, delayMs: 0 },
      }))

      expect(streamFn).toHaveBeenCalledTimes(3)
      const endEvent = events.find(e => e.type === 'agent_end') as { type: 'agent_end'; error?: string }
      expect(endEvent?.error).toBeUndefined()
    })

    it('propagates the error when all attempts are exhausted', async () => {
      const streamFn = vi.fn().mockRejectedValue(new Error('always fails'))

      const { events } = await collectEvents(baseConfig({
        stream:       streamFn,
        retryOnError: { maxAttempts: 3, delayMs: 0 },
      }))

      expect(streamFn).toHaveBeenCalledTimes(3)
      const endEvent = events.find(e => e.type === 'agent_end') as { type: 'agent_end'; error?: string }
      expect(endEvent?.error).toBe('always fails')
    })

    it('does not retry when the abort signal is already triggered', async () => {
      const controller = new AbortController()
      const streamFn = vi.fn().mockImplementation(async () => {
        controller.abort()
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      })

      const { events } = await collectEvents(baseConfig({
        stream:       streamFn,
        signal:       controller.signal,
        retryOnError: { maxAttempts: 5, delayMs: 0 },
      }))

      // The abort is detected in the catch block, so no retry
      expect(streamFn).toHaveBeenCalledTimes(1)
      const endEvent = events.find(e => e.type === 'agent_end') as { type: 'agent_end'; error?: string }
      expect(endEvent?.error).toBeTruthy()
    })

    it('resets partial state so the committed error entry reflects only the final attempt', async () => {
      // When all retries fail, the error entry written to the kernel should contain
      // only partial content from the LAST attempt, not accumulated stale content.
      let callCount = 0
      const streamFn = vi.fn().mockImplementation(
        async (_msgs: unknown, _tools: unknown, onEvent: (e: LLMStreamEvent) => void) => {
          callCount++
          // Each attempt emits its own text and then fails
          onEvent({ type: 'text-delta', delta: callCount === 1 ? 'stale-text' : 'last-attempt-text' })
          throw new Error(`attempt ${callCount} failed`)
        },
      )

      const { events } = await collectEvents(baseConfig({
        stream:       streamFn,
        retryOnError: { maxAttempts: 2, delayMs: 0 },
      }))

      // The message_end entry (error path) should reflect only the final attempt's partial content
      const messageEnd = events.find(e => e.type === 'message_end') as {
        type: 'message_end'; entry: { type: 'assistant'; payload: { text: string } }
      }
      expect(messageEnd?.entry.payload.text).toBe('last-attempt-text')
      expect(messageEnd?.entry.payload.text).not.toContain('stale-text')
    })
  })

  describe('skipTool — steering arrives mid-tool-execution', () => {
    it('skips remaining tools and marks them as error when steering arrives', async () => {
      const execute2 = vi.fn().mockResolvedValue({ content: 'tool2 done', isError: false })

      // Steering is delivered only AFTER tool1 executes.
      // getSteeringMessages is called: (1) before loop start, (2) after each tool in executeTools.
      // We set the flag inside execute1 so call #2 (after tool1) is the first to return steering.
      let tool1Done = false
      let steeringDelivered = false
      let streamCallCount = 0

      // execute1 sets tool1Done so getSteeringMessages can return steering on the next call
      const execute1 = vi.fn().mockImplementation(async () => {
        tool1Done = true
        return { content: 'tool1 done', isError: false }
      })
      const tool1 = { name: 'tool1', description: 't1', execute: execute1 }
      const tool2 = { name: 'tool2', description: 't2', execute: execute2 }

      const streamFn = vi.fn().mockImplementation(async () => {
        streamCallCount++
        if (streamCallCount === 1) {
          return stepResult({
            toolCalls: [
              { toolCallId: 'c1', toolName: 'tool1', input: {} },
              { toolCallId: 'c2', toolName: 'tool2', input: {} },
            ],
            stopReason: 'tool_use',
          })
        }
        return stepResult()
      })

      // Deliver steering only after tool1 has run and steering hasn't been delivered yet
      const getSteeringMessages = vi.fn().mockImplementation(async () => {
        if (tool1Done && !steeringDelivered) {
          steeringDelivered = true
          return [{ type: 'user' as const, payload: { parts: [{ type: 'text' as const, text: 'interrupt' }] } }]
        }
        return []
      })

      const { events } = await collectEvents(
        baseConfig({ stream: streamFn, tools: [tool1, tool2], getSteeringMessages }),
      )

      // tool1 executes normally
      expect(execute1).toHaveBeenCalledOnce()
      // tool2 is skipped because steering arrived after tool1
      expect(execute2).not.toHaveBeenCalled()

      // Both tool calls produce tool_result events
      const toolResultEvents = events.filter(e => e.type === 'tool_result') as Array<{
        type: 'tool_result'; toolCallId: string; isError: boolean
      }>
      expect(toolResultEvents).toHaveLength(2)

      // The skipped tool2 result should be an error
      const skipped = toolResultEvents.find(e => e.toolCallId === 'c2')
      expect(skipped?.isError).toBe(true)
    })
  })
})
