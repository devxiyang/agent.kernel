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

export type LLMStreamEvent =
  | { type: 'text-delta';      delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }

export type LLMStopReason = 'stop' | 'tool_use' | 'length' | 'content_filter' | (string & {})

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
    signal?:    AbortSignal,
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

export interface AgentConfig {
  stream:    StreamFn
  tools:     AgentTool[]
  maxSteps:  number
  signal?:   AbortSignal

  getSteeringMessages?: () => Promise<AgentEntry[]>
  getFollowUpMessages?: () => Promise<AgentEntry[]>

  transformContext?: (
    messages: AgentMessage[],
    signal?:  AbortSignal,
  ) => Promise<AgentMessage[]>

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

export type AgentResult = {
  usage:      Usage
  durationMs: number
}

// ─── Agent options ────────────────────────────────────────────────────────────

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
