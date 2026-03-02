import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentEntry,
  AgentMessage,
  AgentKernel,
  StoredEntry,
  AppendResult,
  CompactionEntry,
  TokenBudget,
  KernelOptions,
  SessionMeta,
  ContentPart,
  DataContent,
} from './types'
import { COMPACTION_TYPE } from './types'

/**
 * Kernel — conversation state manager and optional JSONL persistence layer.
 *
 * Maintains a linked tree of StoredEntry nodes (parentId → id) that models the
 * full conversation history including branches and compaction. The "current branch"
 * is the path from the root to _leafId.
 *
 * Two files are written per session:
 *   - kernel.jsonl — current branch only (rewritten on compact)
 *   - log.jsonl    — append-only full history (never compacted); for UI display
 */

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Create a kernel. Pass options for file-backed persistence; omit for in-memory (tests). */
export function createKernel(options?: KernelOptions): AgentKernel {
  return new Kernel(options)
}

// ─── Kernel implementation ────────────────────────────────────────────────────

class Kernel implements AgentKernel {
  /** All stored entries indexed by id — the in-memory conversation tree. */
  private readonly byId = new Map<number, StoredEntry>()
  /** Next id to assign on append. */
  private nextId           = 0
  /** Input tokens from the most recent assistant entry (tracks context window usage). */
  private tokenUsed        = 0
  /** Configurable context size cap; Infinity until the caller sets budget.set(). */
  private tokenLimit       = Number.POSITIVE_INFINITY

  /** Absolute path to kernel.jsonl, or undefined when running in-memory. */
  private readonly kernelPath: string | undefined
  /** Absolute path to log.jsonl, or undefined when running in-memory. */
  private readonly logPath:    string | undefined

  /** The id of the most recent entry on the current branch (the "tip"). */
  private _leafId: number | null = null

  readonly budget: TokenBudget

  constructor(options?: KernelOptions) {
    if (options) {
      const sessionDir = join(options.dir, options.sessionId)
      mkdirSync(sessionDir, { recursive: true })
      this.kernelPath = join(sessionDir, 'kernel.jsonl')
      this.logPath    = join(sessionDir, 'log.jsonl')

      const metaPath = join(sessionDir, 'meta.json')
      if (!existsSync(metaPath)) {
        const meta: SessionMeta = { createdAt: Date.now(), ...options.meta }
        writeFileSync(metaPath, JSON.stringify(meta))
      } else if (options.meta && Object.keys(options.meta).length > 0) {
        const existing: SessionMeta = JSON.parse(readFileSync(metaPath, 'utf-8'))
        writeFileSync(metaPath, JSON.stringify({ ...existing, ...options.meta }))
      }
    }

    const kernel = this
    this.budget = {
      get used()  { return kernel.tokenUsed  },
      get limit() { return kernel.tokenLimit },
      set(limit: number) { kernel.tokenLimit = limit },
    }

    if (this.kernelPath && existsSync(this.kernelPath)) {
      this.loadFromFile(this.kernelPath)
    }
  }

  // ─── Log ──────────────────────────────────────────────────────────────────

  /**
   * Write an entry to the in-memory tree and (if configured) to both
   * kernel.jsonl and log.jsonl. Advances the leaf pointer.
   */
  append(entry: AgentEntry): AppendResult {
    const result = this.write(entry)
    if (result.ok && this.logPath) {
      appendFileSync(this.logPath, JSON.stringify(entry) + '\n')
    }
    return result
  }

  /** Return all entries on the current branch in chronological order (root → leaf). */
  read(): StoredEntry[] {
    if (this._leafId === null) return []
    return this.walkBranch(this._leafId)
  }

  // ─── Compaction ──────────────────────────────────────────────────────────

  /**
   * Replace entries [fromId, toId] with a single summary entry.
   * Writes a compaction marker to kernel.jsonl, materialises the summary in memory,
   * then rewrites kernel.jsonl to contain only the current branch (no markers).
   * Also appends the summary to log.jsonl as a divider.
   */
  compact(fromId: number, toId: number, summaryText: string): AppendResult {
    const summaryEntry: AgentEntry = { type: 'summary', payload: { text: summaryText } }

    const compactionEntry: CompactionEntry = {
      type:    COMPACTION_TYPE,
      payload: { fromId, toId, summary: summaryEntry },
    }

    const result = this.writeCompaction(compactionEntry)

    if (result.ok) {
      this.materialize(fromId, toId, summaryEntry)
      // Append summary divider to conversation log
      if (this.logPath) {
        appendFileSync(this.logPath, JSON.stringify(summaryEntry) + '\n')
      }
    }

    return result
  }

  // ─── Context size ─────────────────────────────────────────────────────────

  get contextSize(): number {
    const last = this.peek()
    return last?.type === 'assistant' ? (last.usage?.input ?? 0) : 0
  }

  // ─── Branch ───────────────────────────────────────────────────────────────

  get leafId(): number | null {
    return this._leafId
  }

  peek(): StoredEntry | null {
    if (this._leafId === null) return null
    return this.byId.get(this._leafId) ?? null
  }

  branch(toId: number): void {
    if (!this.byId.has(toId)) {
      throw new Error(`Entry ${toId} not found`)
    }
    this._leafId = toId
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  buildMessages(): AgentMessage[] {
    const messages: AgentMessage[] = []
    for (const entry of this.read()) {
      messages.push(...entryToMessages(entry))
    }
    return messages
  }

  // ─── Conversation log ─────────────────────────────────────────────────────

  readLog(): AgentEntry[] {
    if (!this.logPath || !existsSync(this.logPath)) return []
    const content = readFileSync(this.logPath, 'utf-8')
    return content
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as AgentEntry)
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** Internal: assign id/parentId/timestamp, update byId and leafId, persist to kernel.jsonl. */
  private write(entry: AgentEntry): AppendResult {
    const record = {
      ...normalizeEntry(entry),
      id:        this.nextId++,
      parentId:  this._leafId,
      timestamp: Date.now(),
    } as StoredEntry

    this.byId.set(record.id, record)
    this._leafId = record.id

    if (record.type === 'assistant' && record.usage?.input) {
      this.tokenUsed = record.usage.input
    }

    if (this.kernelPath) {
      appendFileSync(this.kernelPath, JSON.stringify(record) + '\n')
    }

    return { ok: true, id: record.id }
  }

  /** Write a raw compaction marker record to kernel.jsonl and advance leafId. */
  private writeCompaction(entry: CompactionEntry): AppendResult {
    const record = {
      ...entry,
      id:        this.nextId++,
      parentId:  this._leafId,
      timestamp: Date.now(),
    }

    this._leafId = record.id

    if (this.kernelPath) {
      appendFileSync(this.kernelPath, JSON.stringify(record) + '\n')
    }

    return { ok: true, id: record.id }
  }

  /**
   * Apply a compaction in-memory: delete the compacted range from byId,
   * insert the summary at the compaction slot, and rewrite kernel.jsonl
   * to hold only the clean current branch.
   */
  private materialize(fromId: number, toId: number, summary: AgentEntry): void {
    const compactionId = this._leafId!

    // The summary takes the place of the compacted range in the tree:
    // its parentId is the parentId of the first compacted entry (fromId).
    const rangeStartParentId = this.byId.get(fromId)?.parentId ?? null

    // Remove compacted entries from byId first
    for (const [id] of this.byId) {
      if (id >= fromId && id <= toId) {
        this.byId.delete(id)
      }
    }

    // Insert summary entry at compactionId, linking to what preceded the range
    const compactionRecord = {
      ...summary,
      id:        compactionId,
      parentId:  rangeStartParentId,
      timestamp: Date.now(),
    } as StoredEntry
    this.byId.set(compactionId, compactionRecord)

    // Rewrite kernel file with current branch (clean, no compaction markers)
    if (this.kernelPath) {
      const branchPath = this.read()
      writeFileSync(this.kernelPath, branchPath.map(e => JSON.stringify(e)).join('\n') + '\n')
    }
  }

  /** Walk the parentId chain from `fromId` back to the root, returning entries root-first. */
  private walkBranch(fromId: number): StoredEntry[] {
    const path: StoredEntry[] = []
    let current = this.byId.get(fromId)
    while (current) {
      path.unshift(current)
      current = current.parentId !== null ? this.byId.get(current.parentId) : undefined
    }
    return path
  }

  /** Replay kernel.jsonl on startup to restore the in-memory tree and leafId. */
  private loadFromFile(filePath: string): void {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n').filter(line => line.trim() !== '')

    for (const line of lines) {
      const record = JSON.parse(line) as StoredEntry
      this.byId.set(record.id, record)
      this._leafId = record.id

      if (record.type === 'assistant' && record.usage?.input) {
        this.tokenUsed = record.usage.input
      }

      if (record.id >= this.nextId) {
        this.nextId = record.id + 1
      }
    }
  }
}

// ─── entryToMessages ──────────────────────────────────────────────────────────

/**
 * Convert a single AgentEntry to zero or more provider-agnostic AgentMessages.
 * Summary entries become user messages with a "[Context Summary]" prefix.
 */
function entryToMessages(entry: AgentEntry): AgentMessage[] {
  switch (entry.type) {
    case 'user': {
      const { parts } = entry.payload
      // Shorthand: single text part → string content
      if (parts.length === 1 && parts[0].type === 'text') {
        return [{ role: 'user', content: parts[0].text }]
      }
      return [{ role: 'user', content: parts }]
    }

    case 'assistant': {
      const { text, reasoning, toolCalls } = entry.payload
      if (!reasoning && toolCalls.length === 0) {
        return [{ role: 'assistant', content: text }]
      }
      const parts: Array<
        | { type: 'text';      text: string }
        | { type: 'reasoning'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
      > = []
      if (reasoning) parts.push({ type: 'reasoning', text: reasoning })
      if (text)     parts.push({ type: 'text', text })
      for (const tc of toolCalls) {
        parts.push({ type: 'tool-call', toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input })
      }
      return [{ role: 'assistant', content: parts }]
    }

    case 'tool_result':
      return [{
        role: 'tool',
        content: [{
          type:       'tool-result',
          toolCallId: entry.payload.toolCallId,
          toolName:   entry.payload.toolName,
          content:    entry.payload.content,
          isError:    entry.payload.isError,
        }],
      }]

    case 'summary':
      return [{ role: 'user', content: `[Context Summary]\n${entry.payload.text}` }]

    default:
      return []
  }
}

// ─── Serialization helpers ────────────────────────────────────────────────────

/**
 * Normalize a ContentPart for JSONL storage.
 * Uint8Array / ArrayBuffer → base64 string. URL → href string.
 */
function normalizeContentPart(part: ContentPart): ContentPart {
  if ('text' in part) return part
  if ('url' in part) return part  // URL string stored as-is
  return { ...part, data: normalizeData(part.data) }
}

/** Convert Uint8Array to base64; pass through strings unchanged. */
function normalizeData(value: DataContent): string {
  if (value instanceof Uint8Array) return bufferToBase64(value)
  return value  // already a base64 string
}

/** Encode raw bytes to a base64 string for JSONL storage. */
function bufferToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Normalize all ContentParts in a user or tool_result entry before persisting.
 */
function normalizeEntry(entry: AgentEntry): AgentEntry {
  if (entry.type === 'user') {
    return { ...entry, payload: { parts: entry.payload.parts.map(normalizeContentPart) } }
  }
  if (entry.type === 'tool_result' && Array.isArray(entry.payload.content)) {
    return {
      ...entry,
      payload: { ...entry.payload, content: entry.payload.content.map(normalizeContentPart) },
    }
  }
  return entry
}

