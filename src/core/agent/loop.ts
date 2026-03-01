/**
 * Agent loop — the "userspace shell" around the kernel.
 *
 * Design:
 *   - No dependency on any LLM provider (AI SDK, OpenAI, etc.).
 *   - Provider is injected as StreamFn; tools are injected as AgentTool[].
 *   - The kernel is the single source of truth for conversation history.
 *   - Nested loop pattern: inner loop handles tool calls
 *     and steering; outer loop handles follow-up messages.
 *
 * Each inner iteration (one turn):
 *   1. Write pending entries to kernel.
 *   2. Emit turn_start.
 *   3. buildContext → transformContext? → AgentMessage[]
 *   4. stream(messages) → LLMStepResult, emitting LLMStreamEvents to UI.
 *   5. Write assistant entry to kernel.
 *   6. Execute tool calls (write each result to kernel, check steering between calls).
 *   7. Emit turn_end { toolResults }.
 *   8. If tool calls were made → repeat from 1 (LLM processes results).
 *   9. Else → check for follow-up messages (outer loop) or stop.
 */

import { Value } from '@sinclair/typebox/value'
import { EventStream } from '../../event-stream'
import type { AgentKernel } from '../kernel'
import type {
  AgentEntry,
  AgentConfig,
  AgentEvent,
  AgentResult,
  AgentTool,
  LLMStreamEvent,
  ToolCallInfo,
  ToolResult,
  ToolResultInfo,
  Usage,
} from './types'

// ─── runLoop ──────────────────────────────────────────────────────────────────

/**
 * Start the agent loop. Returns an EventStream immediately.
 * Consumer iterates events with `for await` and awaits stream.result().
 */
export function runLoop(
  kernel: AgentKernel,
  config: AgentConfig,
): EventStream<AgentEvent, AgentResult> {
  const stream = new EventStream<AgentEvent, AgentResult>()
  void _run(kernel, config, stream)
  return stream
}

// ─── _run ─────────────────────────────────────────────────────────────────────

async function _run(
  kernel:  AgentKernel,
  config:  AgentConfig,
  stream:  EventStream<AgentEvent, AgentResult>,
): Promise<void> {
  const startedAt       = Date.now()
  let   stepText        = ''    // current step text; reset on each step start
  let   stepReasoning   = ''    // current step reasoning; reset on each step start
  let   stepNumber      = 0
  let   totalUsage: Usage = {
    input:      0,
    output:     0,
    cacheRead:  0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  // Partial tool calls streamed in the current LLM step (cleared on each step start).
  let partialToolCalls: ToolCallInfo[] = []

  stream.push({ type: 'agent_start' })

  try {
    // Check for any messages already queued before this run starts (e.g. steering
    // messages typed while a previous run was finishing)
    let pendingMessages: AgentEntry[] = await config.getSteeringMessages?.() ?? []

    // ── Outer loop: continues when follow-up messages arrive ──────────────
    while (true) {
      let hasMoreToolCalls = true
      let steeringAfterTools: AgentEntry[] | null = null

      // ── Inner loop: one LLM call + tool execution per iteration ─────────
      while (hasMoreToolCalls || pendingMessages.length > 0) {
        // Write pending steering / follow-up entries to kernel
        for (const entry of pendingMessages) {
          kernel.append(entry)
        }
        pendingMessages = []

        if (stepNumber >= config.maxSteps) {
          hasMoreToolCalls = false
          break
        }

        stream.push({ type: 'turn_start' })

        // Build conversation context from kernel; allow caller to transform it
        const rawMessages = kernel.buildMessages()
        const messages    = await config.transformContext?.(rawMessages, config.signal) ?? rawMessages

        // Signal start of assistant message
        stream.push({ type: 'message_start', entry: { type: 'assistant', payload: { text: '', toolCalls: [] } } })

        // Reset per-step partial tracking (also reset before each retry attempt)
        const resetPartials = () => {
          partialToolCalls = []
          stepText         = ''
          stepReasoning    = ''
        }
        resetPartials()

        // Call the LLM; onEvent forwards real-time events to the UI stream
        const makeOnEvent = () => (event: LLMStreamEvent) => {
          if (event.type === 'text-delta') {
            stepText += event.delta
            stream.push({ type: 'text_delta', delta: event.delta })
          } else if (event.type === 'reasoning-delta') {
            stepReasoning += event.delta
            stream.push({ type: 'reasoning_delta', delta: event.delta })
          } else if (event.type === 'tool-call') {
            partialToolCalls.push({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input })
            stream.push({ type: 'tool_call', toolCallId: event.toolCallId, toolName: event.toolName, input: event.input })
          }
        }

        const streamCall = () => {
          resetPartials()
          return config.stream(messages, config.tools, makeOnEvent(), config.signal)
        }
        const stepResult = config.retryOnError
          ? await withRetry(streamCall, config.retryOnError, config.signal)
          : await streamCall()

        stepNumber++
        accumulateUsage(totalUsage, stepResult.usage)

        // Write the assistant turn to kernel
        const assistantEntry: AgentEntry = {
          type:    'assistant',
          payload: {
            text:       stepResult.text,
            reasoning:  stepResult.reasoning,
            toolCalls:  stepResult.toolCalls,
            stopReason: stepResult.stopReason,
          },
          usage: stepResult.usage,
        }
        kernel.append(assistantEntry)

        stream.push({ type: 'message_end', entry: assistantEntry })
        stream.push({ type: 'step_done', stepNumber, usage: stepResult.usage })
        await config.onStepEnd?.(kernel, stepNumber)

        // ── onContextFull hook ────────────────────────────────────────────
        if (config.onContextFull && kernel.budget.limit < Infinity && kernel.contextSize >= kernel.budget.limit) {
          await config.onContextFull(kernel, stepNumber)
        }

        // ── Execute tool calls ────────────────────────────────────────────
        hasMoreToolCalls = stepResult.toolCalls.length > 0
        let turnToolResults: ToolResultInfo[] = []

        if (hasMoreToolCalls) {
          const result = await executeTools(
            stepResult.toolCalls,
            config.tools,
            kernel,
            stream,
            config.signal,
            config.getSteeringMessages,
            config.parallelTools ?? false,
            config.toolTimeout,
          )
          turnToolResults    = result.toolResults
          steeringAfterTools = result.steeringMessages ?? null
        }

        stream.push({ type: 'turn_end', toolResults: turnToolResults })

        // Update pending messages for next inner iteration
        if (steeringAfterTools && steeringAfterTools.length > 0) {
          pendingMessages    = steeringAfterTools
          steeringAfterTools = null
        } else {
          pendingMessages = await config.getSteeringMessages?.() ?? []
        }
      }
      // ────────────────────────────────────────────────────────────────────

      // Agent would stop here — check for queued follow-up messages
      const followUps = await config.getFollowUpMessages?.() ?? []
      if (followUps.length > 0) {
        pendingMessages = followUps
        continue
      }

      break
    }
    // ──────────────────────────────────────────────────────────────────────

    stream.push({ type: 'agent_end' })
    stream.end({
      usage:      totalUsage,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const isAbort = error instanceof Error && error.name === 'AbortError'
    const stopReason = isAbort ? 'aborted' as const : 'error' as const

    // If meaningful content was streamed before the error/abort, save it as a
    // normal assistant entry (no error field) — the user can see what was produced.
    // Only add the error field when nothing useful was streamed.
    // Use step-scoped partials — previous steps are already committed to kernel.
    const hasContent = stepText.trim().length > 0 || stepReasoning.trim().length > 0 || partialToolCalls.length > 0
    const errorEntry: AgentEntry = hasContent
      ? { type: 'assistant', payload: { text: stepText, reasoning: stepReasoning || undefined, toolCalls: partialToolCalls, stopReason } }
      : { type: 'assistant', payload: { text: '', toolCalls: [], stopReason, error: errorMessage } }
    kernel.append(errorEntry)
    stream.push({ type: 'message_end', entry: errorEntry })
    stream.push({ type: 'turn_end', toolResults: [] })

    stream.push({ type: 'agent_end', error: errorMessage })
    stream.end({
      usage:      totalUsage,
      durationMs: Date.now() - startedAt,
    })
  }
}

// ─── executeTools ─────────────────────────────────────────────────────────────

async function executeTools(
  toolCalls:           ToolCallInfo[],
  tools:               AgentTool[],
  kernel:              AgentKernel,
  stream:              EventStream<AgentEvent, AgentResult>,
  signal:              AbortSignal | undefined,
  getSteeringMessages: AgentConfig['getSteeringMessages'],
  parallelTools:       boolean,
  toolTimeout:         number | undefined,
): Promise<{ steeringMessages?: AgentEntry[]; toolResults: ToolResultInfo[] }> {
  if (parallelTools) {
    return executeToolsParallel(toolCalls, tools, kernel, stream, signal, getSteeringMessages, toolTimeout)
  }
  return executeToolsSequential(toolCalls, tools, kernel, stream, signal, getSteeringMessages, toolTimeout)
}

async function executeToolsSequential(
  toolCalls:           ToolCallInfo[],
  tools:               AgentTool[],
  kernel:              AgentKernel,
  stream:              EventStream<AgentEvent, AgentResult>,
  signal:              AbortSignal | undefined,
  getSteeringMessages: AgentConfig['getSteeringMessages'],
  toolTimeout:         number | undefined,
): Promise<{ steeringMessages?: AgentEntry[]; toolResults: ToolResultInfo[] }> {
  let steeringMessages: AgentEntry[] | undefined
  const toolResults: ToolResultInfo[] = []

  for (const tc of toolCalls) {
    // If steering arrived during a previous tool call, skip the rest
    if (steeringMessages) {
      const skipped = skipTool(tc.toolCallId, tc.toolName, kernel, stream)
      toolResults.push({ toolCallId: tc.toolCallId, toolName: tc.toolName, ...skipped })
      continue
    }

    const result = await runSingleTool(tc, tools, stream, signal, toolTimeout)

    const { content, isError, details } = result
    const toolResultEntry: AgentEntry = {
      type:    'tool_result',
      payload: { toolCallId: tc.toolCallId, toolName: tc.toolName, content, isError },
    }
    kernel.append(toolResultEntry)
    stream.push({ type: 'tool_result', toolCallId: tc.toolCallId, content, isError, details })
    toolResults.push({ toolCallId: tc.toolCallId, toolName: tc.toolName, content, isError, details })

    // Check for steering messages between tool calls (SIGINT semantics)
    const steering = await getSteeringMessages?.() ?? []
    if (steering.length > 0) {
      steeringMessages = steering
    }
  }

  return { steeringMessages, toolResults }
}

async function executeToolsParallel(
  toolCalls:           ToolCallInfo[],
  tools:               AgentTool[],
  kernel:              AgentKernel,
  stream:              EventStream<AgentEvent, AgentResult>,
  signal:              AbortSignal | undefined,
  getSteeringMessages: AgentConfig['getSteeringMessages'],
  toolTimeout:         number | undefined,
): Promise<{ steeringMessages?: AgentEntry[]; toolResults: ToolResultInfo[] }> {
  let steeringArrived = false

  // Per-tool AbortControllers linked to the parent signal
  const controllers = toolCalls.map(() => new AbortController())
  if (signal) {
    const onAbort = () => controllers.forEach(c => c.abort())
    signal.addEventListener('abort', onAbort, { once: true })
  }

  // Run all tools concurrently
  const settled = await Promise.allSettled(
    toolCalls.map((tc, i) => runSingleTool(tc, tools, stream, controllers[i].signal, toolTimeout)),
  )

  // Check for steering after all tools complete
  const steeringMessages = await getSteeringMessages?.() ?? []
  if (steeringMessages.length > 0) {
    steeringArrived = true
  }

  const toolResults: ToolResultInfo[] = []

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]
    const outcome = settled[i]

    // If steering arrived, discard results and skip remaining
    if (steeringArrived) {
      const skipped = skipTool(tc.toolCallId, tc.toolName, kernel, stream)
      toolResults.push({ toolCallId: tc.toolCallId, toolName: tc.toolName, ...skipped })
      continue
    }

    const result: ToolResult = outcome.status === 'fulfilled'
      ? outcome.value
      : { content: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason), isError: true }

    const { content, isError, details } = result
    const toolResultEntry: AgentEntry = {
      type:    'tool_result',
      payload: { toolCallId: tc.toolCallId, toolName: tc.toolName, content, isError },
    }
    kernel.append(toolResultEntry)
    stream.push({ type: 'tool_result', toolCallId: tc.toolCallId, content, isError, details })
    toolResults.push({ toolCallId: tc.toolCallId, toolName: tc.toolName, content, isError, details })
  }

  return { steeringMessages: steeringArrived ? steeringMessages : undefined, toolResults }
}

async function runSingleTool(
  tc:          ToolCallInfo,
  tools:       AgentTool[],
  stream:      EventStream<AgentEvent, AgentResult>,
  signal:      AbortSignal | undefined,
  toolTimeout: number | undefined,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === tc.toolName)

  try {
    if (!tool) throw new Error(`Tool not found: ${tc.toolName}`)

    const validated = validateInput(tool, tc.input)
    if (!validated.ok) {
      return { content: validated.content, isError: true }
    }

    const execPromise = tool.execute(
      tc.toolCallId,
      validated.value,
      signal,
      (partial) => stream.push({ type: 'tool_update', toolCallId: tc.toolCallId, partial }),
    )

    return await (toolTimeout ? withTimeout(execPromise, toolTimeout, signal) : execPromise)
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true }
  }
}

// ─── withTimeout ──────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool timed out after ${ms}ms`)), ms)
    const clear = () => clearTimeout(timer)
    signal?.addEventListener('abort', clear)
    promise.then(v => { clear(); resolve(v) }, e => { clear(); reject(e) })
  })
}

// ─── withRetry ────────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts: number; delayMs: number },
  signal?: AbortSignal,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try { return await fn() } catch (err) {
      if (signal?.aborted) throw err
      if (attempt === opts.maxAttempts) throw err
      lastErr = err
      await new Promise(r => setTimeout(r, opts.delayMs))
    }
  }
  throw lastErr
}

// ─── accumulateUsage ──────────────────────────────────────────────────────────

function accumulateUsage(acc: Usage, step: Usage): void {
  acc.input      += step.input
  acc.output     += step.output
  acc.cacheRead  += step.cacheRead
  acc.cacheWrite += step.cacheWrite
  acc.totalTokens += step.totalTokens
  acc.cost.input      += step.cost.input
  acc.cost.output     += step.cost.output
  acc.cost.cacheRead  += step.cost.cacheRead
  acc.cost.cacheWrite += step.cost.cacheWrite
  acc.cost.total      += step.cost.total
}

// ─── validateInput ────────────────────────────────────────────────────────────

type ValidationOk  = { ok: true;  value: Record<string, unknown> }
type ValidationErr = { ok: false; content: string }

function validateInput(
  tool:  AgentTool,
  input: Record<string, unknown>,
): ValidationOk | ValidationErr {
  if (!tool.parameters) return { ok: true, value: input }
  try {
    const value = Value.Parse(tool.parameters, input) as Record<string, unknown>
    return { ok: true, value }
  } catch {
    const errors  = [...Value.Errors(tool.parameters, input)]
    const detail  = errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ')
    return { ok: false, content: detail || 'Parameter validation failed' }
  }
}

// ─── skipTool ─────────────────────────────────────────────────────────────────

function skipTool(
  toolCallId: string,
  toolName:   string,
  kernel:     AgentKernel,
  stream:     EventStream<AgentEvent, AgentResult>,
): ToolResult {
  const content = 'Skipped: user interrupted.'
  kernel.append({
    type:    'tool_result',
    payload: { toolCallId, toolName, content, isError: true },
  })
  stream.push({ type: 'tool_result', toolCallId, content, isError: true })
  return { content, isError: true }
}
