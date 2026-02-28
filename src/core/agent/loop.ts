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

        // Reset per-step partial tracking
        partialToolCalls = []
        stepText         = ''
        stepReasoning    = ''

        // Call the LLM; onEvent forwards real-time events to the UI stream
        const stepResult = await config.stream(
          messages,
          config.tools,
          (event) => {
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
          },
          config.signal,
        )

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

    const tool = tools.find((t) => t.name === tc.toolName)

    let result: ToolResult

    try {
      if (!tool) throw new Error(`Tool not found: ${tc.toolName}`)

      const validated = validateInput(tool, tc.input)
      if (!validated.ok) {
        result = { content: validated.content, isError: true }
      } else {
        result = await tool.execute(
          tc.toolCallId,
          validated.value,
          signal,
          (partial) => stream.push({ type: 'tool_update', toolCallId: tc.toolCallId, partial }),
        )
      }
    } catch (err) {
      result = { content: err instanceof Error ? err.message : String(err), isError: true }
    }

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
