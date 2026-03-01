/**
 * Type definitions for the Kernel module.
 *
 * Covers token usage tracking, multimodal content parts, conversation entries
 * (AgentEntry / AgentMessage), the persistent store format (StoredEntry),
 * compaction, and the AgentKernel interface.
 */

// ─── Usage ────────────────────────────────────────────────────────────────────

/** Token counts and estimated cost for a single LLM call or an aggregated run. */
export type Usage = {
  /** Tokens in the prompt (input to the model). */
  input:      number
  /** Tokens in the completion (output from the model). */
  output:     number
  /** Tokens read from the prompt cache. */
  cacheRead:  number
  /** Tokens written to the prompt cache. */
  cacheWrite: number
  /** Sum of all token categories. */
  totalTokens: number
  /** Estimated cost breakdown in USD. */
  cost: {
    input:      number
    output:     number
    cacheRead:  number
    cacheWrite: number
    total:      number
  }
}

// ─── Content parts ────────────────────────────────────────────────────────────

/** Raw binary or base64-encoded string. */
export type DataContent = string | Uint8Array

/** Discriminated source: file path / HTTP URL, or raw binary / base64. */
type UrlSource  = { url:  string }
type DataSource = { data: DataContent }
type MediaSource = UrlSource | DataSource

// Common MIME types per category. `(string & {})` keeps autocomplete while
// allowing any valid MIME type not listed here.
export type ImageMediaType =
  | 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  | 'image/bmp'  | 'image/svg+xml' | 'image/tiff'
  | (string & {})

export type AudioMediaType =
  | 'audio/mpeg' | 'audio/wav' | 'audio/ogg' | 'audio/flac'
  | 'audio/aac'  | 'audio/webm' | 'audio/mp4'
  | (string & {})

export type VideoMediaType =
  | 'video/mp4' | 'video/webm' | 'video/ogg'
  | 'video/quicktime' | 'video/x-msvideo'
  | (string & {})

export type FileMediaType =
  | 'application/pdf' | 'application/json' | 'application/xml'
  | 'text/plain' | 'text/html' | 'text/csv' | 'text/markdown'
  | (string & {})

export type TextPart  = { type: 'text';  text: string }
export type ImagePart = { type: 'image'; mediaType?: ImageMediaType } & MediaSource
export type AudioPart = { type: 'audio'; mediaType?: AudioMediaType } & MediaSource
export type VideoPart = { type: 'video'; mediaType?: VideoMediaType } & MediaSource
export type FilePart  = { type: 'file';  mediaType: FileMediaType; filename?: string } & MediaSource

/** Union of all content parts usable in user messages and tool results. */
export type ContentPart = TextPart | ImagePart | AudioPart | VideoPart | FilePart

// ─── AgentEntry ───────────────────────────────────────────────────────────────

/** Reason the model stopped generating. 'error' and 'aborted' are set by the loop, not the provider. */
export type StopReason = 'stop' | 'tool_use' | 'error' | 'aborted' | 'length' | 'content_filter' | (string & {})

/** Minimal descriptor of a single tool invocation requested by the LLM. */
export type ToolCallInfo = {
  toolCallId: string
  toolName:   string
  /** Raw JSON object the LLM produced as the tool's arguments. */
  input:      Record<string, unknown>
}

/**
 * A single turn in the conversation, as stored in the kernel.
 *
 * - user        — one or more content parts from the human
 * - assistant   — model response: text, optional reasoning, and/or tool calls
 * - tool_result — result of executing a tool requested by the model
 * - summary     — compacted representation of a range of earlier entries
 */
export type AgentEntry =
  | { type: 'user';        payload: { parts: ContentPart[] } }
  | { type: 'assistant';   payload: { text: string; reasoning?: string; toolCalls: ToolCallInfo[]; stopReason?: StopReason; error?: string }; usage?: Usage }
  | { type: 'tool_result'; payload: { toolCallId: string; toolName: string; content: string | ContentPart[]; isError: boolean } }
  | { type: 'summary';     payload: { text: string } }

// ─── AgentMessage (provider-agnostic LLM message format) ─────────────────────

/**
 * Normalised message format passed to StreamFn.
 * Provider adapters translate this into their own SDK's message shape.
 * Three roles mirror the OpenAI / Anthropic convention: user, assistant, tool.
 */
export type AgentMessage =
  | {
    role: 'user'
    content: string | ContentPart[]
  }
  | {
    role: 'assistant'
    content: string | Array<
      | TextPart
      | { type: 'reasoning'; text: string }
      | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
    >
  }
  | {
    role: 'tool'
    content: Array<{
      type:       'tool-result'
      toolCallId: string
      toolName:   string
      content:    string | ContentPart[]
      isError:    boolean
    }>
  }

// ─── Stored entry ─────────────────────────────────────────────────────────────

/**
 * An AgentEntry decorated with persistence metadata.
 * Forms a linked tree (parentId → id) that supports conversation branching.
 */
export type StoredEntry = AgentEntry & {
  /** Auto-incrementing unique identifier within a session. */
  readonly id:        number
  /** ID of the preceding entry on this branch, or null for the root. */
  readonly parentId:  number | null
  /** Unix timestamp (ms) at which this entry was written. */
  readonly timestamp: number
}

// ─── Append result ────────────────────────────────────────────────────────────

/** Return value of kernel.append() and kernel.compact(). */
export type AppendResult =
  | { ok: true;  id: number }
  | { ok: false; reason: string }

// ─── Compaction ───────────────────────────────────────────────────────────────

/** Sentinel type string used to identify compaction records in kernel.jsonl. */
export const COMPACTION_TYPE = '__compaction__' as const

/**
 * A compaction marker written to kernel.jsonl. Records the original entry range
 * so that a compact can be replayed on load, then replaced in-memory by a summary.
 */
export type CompactionEntry = {
  type:    typeof COMPACTION_TYPE
  payload: { fromId: number; toId: number; summary: AgentEntry }
  usage?:  Usage
}

// ─── Token budget ─────────────────────────────────────────────────────────────

/**
 * Tracks the context window utilisation for the current session.
 * The loop checks `used >= limit` to decide whether to fire `onContextFull`.
 */
export interface TokenBudget {
  /** Tokens consumed by the last assistant step (from usage.input). */
  readonly used:  number
  /** Maximum allowed context size before compaction is triggered. */
  readonly limit: number
  /** Set the context size limit (e.g. model's context window * 0.8). */
  set(limit: number): void
}

// ─── AgentKernel interface ───────────────────────────────────────────────────

export interface AgentKernel {
  // ── Log ──────────────────────────────────────────────────────────────────
  append(entry: AgentEntry): AppendResult
  read(): StoredEntry[]

  // ── Compaction ───────────────────────────────────────────────────────────
  compact(fromId: number, toId: number, summaryText: string): AppendResult

  // ── Resources ────────────────────────────────────────────────────────────
  readonly budget:      TokenBudget
  /** Current context size: last assistant entry's usage.input. */
  readonly contextSize: number

  // ── Branch ──────────────────────────────────────────────────────────────
  readonly leafId: number | null
  peek(): StoredEntry | null
  branch(toId: number): void

  // ── Messages ─────────────────────────────────────────────────────────────
  /** Build provider-agnostic messages from current branch (compaction-aware). */
  buildMessages(): AgentMessage[]

  // ── Conversation log ──────────────────────────────────────────────────────
  /** Full conversation history, never compacted. UI reads this. */
  readLog(): AgentEntry[]
}

// ─── Session metadata ─────────────────────────────────────────────────────────

export type SessionMeta = {
  createdAt: number   // set once at creation, never overwritten
  title?:    string
}

// ─── Kernel options ──────────────────────────────────────────────────────────

export interface KernelOptions {
  /** Session directory and ID for persistence. Omit for in-memory mode. */
  dir:       string
  sessionId: string
  /** Optional metadata to set/merge on the session. `createdAt` is auto-set and cannot be overwritten. */
  meta?:     Partial<Omit<SessionMeta, 'createdAt'>>
}
