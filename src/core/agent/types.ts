/**
 * Type definitions for the Agent module.
 *
 * Covers the provider-agnostic LLM streaming contract (StreamFn / LLMStreamEvent),
 * tool definitions (AgentTool / ToolResult), execution hooks (ToolWrapHooks),
 * agent configuration (AgentConfig / AgentOptions), and the event bus (AgentEvent).
 */

import type { TObject, Static } from '@sinclair/typebox'
import type {
  Usage,
  AgentEntry,
  AgentMessage,
  AgentKernel,
  ContentPart,
  ToolCallInfo,
} from '../kernel'

export type {
  Usage,
  StopReason,
  ToolCallInfo,
  AgentEntry,
  AgentMessage,
} from '../kernel'

// ─── LLM stream abstraction ───────────────────────────────────────────────────

/**
 * Real-time events emitted by the provider during a single LLM call.
 * The loop forwards these to the UI event stream as they arrive.
 */
export type LLMStreamEvent =
  | { type: 'text-delta';      delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }

/** Reason the LLM stopped generating in a given step. */
export type LLMStopReason = 'stop' | 'tool_use' | 'length' | 'content_filter' | (string & {})

/**
 * Resolved value returned by StreamFn after a single LLM call completes.
 * Contains the full text/reasoning, all tool calls requested, and token usage.
 */
export type LLMStepResult = {
  text:       string
  reasoning?: string
  toolCalls:  ToolCallInfo[]
  stopReason: LLMStopReason
  usage:      Usage
}

/**
 * Provider-injected stream function. Implementer closes over model, API key,
 * system prompt, and any other provider config.
 *
 * `tools` carries the full AgentTool definitions (name, description, parameters)
 * so the provider adapter can build its own tool schema without hardcoding it.
 */
export type StreamFn = (
  messages: AgentMessage[],
  tools:    AgentTool[],
  onEvent:  (event: LLMStreamEvent) => void,
  signal?:  AbortSignal,
) => Promise<LLMStepResult>

// ─── Agent tool ───────────────────────────────────────────────────────────────

export type ToolContent = string | ContentPart[]

/**
 * Result returned by a tool's execute function.
 *
 * - `content`  — what the LLM sees (text or multimodal parts)
 * - `isError`  — whether this is an error result
 * - `details`  — structured data for the UI only; the LLM never sees this
 */
export type ToolResult<TDetails = unknown> = {
  content:   ToolContent
  isError:   boolean
  details?:  TDetails
}

export type AgentTool<
  TSchema  extends TObject = TObject,
  TDetails = unknown,
> = {
  name:         string
  /** Human-readable label for UI display. Defaults to `name` if omitted. */
  label?:       string
  /** Passed to the LLM provider as the tool description. */
  description:  string
  /**
   * TypeBox schema for the tool's input parameters.
   * Used for runtime validation in the loop and passed directly to the provider
   * as JSON Schema (TypeBox schemas are standard JSON Schema at runtime).
   */
  parameters?:  TSchema
  execute: (
    toolCallId: string,
    input:      Static<TSchema>,
    signal:     AbortSignal,
    onUpdate?:  (partial: ToolResult<TDetails>) => void,
  ) => Promise<ToolResult<TDetails>>
}

// ─── Tool wrap hooks ──────────────────────────────────────────────────────────

/**
 * Return value from BeforeToolCallHook:
 *  - `{ action: 'block', reason }` — framework-handled: skip tool, return reason as error
 *  - `{ action: string }` — caller-defined extension; framework passes through as-is
 *  - `void`              — allow as-is
 */
export type BlockResult = { action: 'block'; reason: string }

export type BeforeToolCallResult =
  | BlockResult
  | { action: string & {} }

export type BeforeToolCallHook = (
  toolCallId: string,
  toolName:   string,
  input:      Record<string, unknown>,
) => Promise<BeforeToolCallResult | void> | BeforeToolCallResult | void

/**
 * Partial override of the tool result. Only fields you return are applied;
 * return void to keep the original unchanged.
 */
export type AfterToolCallResult = {
  content?:  ToolContent
  isError?:  boolean
  details?:  unknown
}

export type AfterToolCallHook = (
  toolCallId: string,
  toolName:   string,
  result:     ToolResult,
) => Promise<AfterToolCallResult | void> | AfterToolCallResult | void

export type ToolWrapHooks = {
  before?: BeforeToolCallHook
  after?:  AfterToolCallHook
}

// ─── Agent config ─────────────────────────────────────────────────────────────

export type ToolResultInfo = {
  toolCallId: string
  toolName:   string
  content:    ToolContent
  isError:    boolean
  details?:   unknown
}

/**
 * Runtime configuration passed to runLoop on each execution.
 * Most fields mirror AgentOptions; the queue-drain callbacks are wired by Agent.
 */
export interface AgentConfig {
  /** Provider-injected streaming function. */
  stream:    StreamFn
  /** Tools made available to the LLM for this run. */
  tools:     AgentTool[]
  /** Maximum number of LLM + tool-execution cycles before the loop stops. */
  maxSteps:  number
  /** Abort signal forwarded to stream calls and tool executions. */
  signal?:   AbortSignal

  /** Returns queued steering entries; called between tool calls and before each LLM step. */
  getSteeringMessages?: () => Promise<AgentEntry[]>
  /**
   * Returns the current steering AbortSignal. Called before each tool batch so the
   * loop always gets the latest signal. When a steering message is queued the caller
   * aborts this signal (and immediately resets it), which causes all tools in the
   * current batch to receive an abort — fulfilling the cooperative-cancellation contract.
   */
  getSteeringSignal?: () => AbortSignal
  /** Returns queued follow-up entries; checked after the agent would otherwise stop. */
  getFollowUpMessages?: () => Promise<AgentEntry[]>

  /**
   * Optional hook to modify or replace the message array before each LLM call.
   * Useful for injecting system context, filtering, or summarising long threads.
   */
  transformContext?: (
    messages: AgentMessage[],
    signal?:  AbortSignal,
  ) => Promise<AgentMessage[]>

  /** Called after every completed LLM step. Useful for side-effects or logging. */
  onStepEnd?: (kernel: AgentKernel, stepNumber: number) => Promise<void>

  /** Run tool calls concurrently. Default: false (sequential). */
  parallelTools?: boolean

  /** Fired when context size reaches or exceeds budget.limit. Callback should call kernel.compact(). */
  onContextFull?: (kernel: AgentKernel, stepNumber: number) => Promise<void>

  /** Per-tool execution timeout in ms. Undefined = no timeout. */
  toolTimeout?: number

  /** Retry config for LLM stream errors. */
  retryOnError?: {
    maxAttempts: number
    delayMs:     number
  }
}

// ─── Agent events ─────────────────────────────────────────────────────────────

/**
 * All events emitted by the agent loop.
 *
 * Lifecycle:  agent_start → (turn_start → message_start → … → message_end
 *             → tool_call* → tool_result* → turn_end → step_done)* → agent_end
 *
 * - agent_start / agent_end    — wraps the entire run
 * - turn_start / turn_end      — wraps one LLM call + tool execution cycle
 * - message_start / message_end — wraps the streaming assistant message
 * - text_delta / reasoning_delta — incremental text chunks from the LLM
 * - tool_call                  — a tool the LLM requested to execute
 * - tool_update                — partial progress update from a long-running tool
 * - tool_result                — final result after a tool finishes
 * - step_done                  — emitted after tool results are written to kernel
 */
export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; error?: string }
  | { type: 'turn_start' }
  | { type: 'turn_end'; toolResults: ToolResultInfo[] }
  | { type: 'message_start'; entry: AgentEntry }
  | { type: 'message_end';   entry: AgentEntry }
  | { type: 'text_delta';    delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call';   toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_update'; toolCallId: string; partial: ToolResult }
  | { type: 'tool_result'; toolCallId: string; content: ToolContent; isError: boolean; details?: unknown }
  | { type: 'step_done';   stepNumber: number; usage: Usage }

// ─── Agent result ─────────────────────────────────────────────────────────────

/** Resolved value of EventStream.result() after a successful agent run. */
export type AgentResult = {
  /** Aggregated token usage across all steps in the run. */
  usage:      Usage
  /** Wall-clock duration of the entire run in milliseconds. */
  durationMs: number
}

// ─── Agent options ────────────────────────────────────────────────────────────

/**
 * Controls how queued steering or follow-up messages are drained each time the
 * agent checks the queue.
 *
 * - 'one-at-a-time' — dequeue a single entry per check (default)
 * - 'all'           — dequeue all pending entries at once
 */
export type QueueMode = 'all' | 'one-at-a-time'

export interface AgentOptions {
  stream:            StreamFn
  tools:             AgentTool[]
  maxSteps:          number
  transformContext?: AgentConfig['transformContext']
  onStepEnd?:        AgentConfig['onStepEnd']
  steeringMode?:     QueueMode
  followUpMode?:     QueueMode
  parallelTools?:    AgentConfig['parallelTools']
  onContextFull?:    AgentConfig['onContextFull']
  toolTimeout?:      AgentConfig['toolTimeout']
  retryOnError?:     AgentConfig['retryOnError']
}
