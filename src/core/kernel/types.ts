// ─── Usage ────────────────────────────────────────────────────────────────────

export type Usage = {
  input:      number
  output:     number
  cacheRead:  number
  cacheWrite: number
  totalTokens: number
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

export type StopReason = 'stop' | 'tool_use' | 'error' | 'aborted' | 'length' | 'content_filter' | (string & {})

export type ToolCallInfo = {
  toolCallId: string
  toolName:   string
  input:      Record<string, unknown>
}

export type AgentEntry =
  | { type: 'user';        payload: { parts: ContentPart[] } }
  | { type: 'assistant';   payload: { text: string; reasoning?: string; toolCalls: ToolCallInfo[]; stopReason?: StopReason; error?: string }; usage?: Usage }
  | { type: 'tool_result'; payload: { toolCallId: string; toolName: string; content: string | ContentPart[]; isError: boolean } }
  | { type: 'summary';     payload: { text: string } }

// ─── AgentMessage (provider-agnostic LLM message format) ─────────────────────

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

export type StoredEntry = AgentEntry & {
  readonly id:        number
  readonly parentId:  number | null
  readonly timestamp: number
}

// ─── Append result ────────────────────────────────────────────────────────────

export type AppendResult =
  | { ok: true;  id: number }
  | { ok: false; reason: string }

// ─── Compaction ───────────────────────────────────────────────────────────────

export const COMPACTION_TYPE = '__compaction__' as const

export type CompactionEntry = {
  type:    typeof COMPACTION_TYPE
  payload: { fromId: number; toId: number; summary: AgentEntry }
  usage?:  Usage
}

// ─── Token budget ─────────────────────────────────────────────────────────────

export interface TokenBudget {
  readonly used:  number
  readonly limit: number
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
