/**
 * Agent — stateful wrapper around kernel + runLoop.
 *
 * Owns:
 *   - AbortController lifecycle (per-prompt)
 *   - Steering / follow-up message queues
 *   - Event fan-out to subscribers
 *   - Mutable config (stream, tools, maxSteps)
 *   - Runtime state (streaming message, pending tool calls, error)
 *
 * Does not own:
 *   - Kernel lifecycle (caller creates and passes in)
 *   - Conversation log (kernel handles both kernel.jsonl and log.jsonl)
 *   - Compaction decisions (caller checks kernel.contextSize and calls kernel.compact())
 */

import type { AgentKernel, KernelOptions } from '../kernel'
import { createKernel } from '../kernel'
import { runLoop } from './loop'
import type {
  AgentEntry,
  AgentEvent,
  AgentResult,
  AgentOptions,
  AgentTool,
  StreamFn,
  ToolCallInfo,
  QueueMode,
} from './types'

// ─── Agent state ─────────────────────────────────────────────────────────────

export interface AgentState {
  /** Whether the agent is currently running a loop. */
  isRunning:        boolean
  /** The partial assistant entry being streamed (null when idle). */
  streamEntry:      AgentEntry | null
  /** Tool call IDs currently executing. */
  pendingToolCalls: Set<string>
  /** Last error message (cleared on next prompt/continue). */
  error:            string | null
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export class Agent {
  private readonly _kernel: AgentKernel

  private _stream:           StreamFn
  private _tools:            AgentTool[]
  private _maxSteps:         number
  private _transformContext: AgentOptions['transformContext']
  private _onStepEnd:        AgentOptions['onStepEnd']
  private _steeringMode:     QueueMode
  private _followUpMode:     QueueMode
  private _parallelTools:    AgentOptions['parallelTools']
  private _onContextFull:    AgentOptions['onContextFull']
  private _toolTimeout:      AgentOptions['toolTimeout']
  private _retryOnError:     AgentOptions['retryOnError']

  private _abortController: AbortController | null = null
  private _runningPromise:  Promise<AgentResult | undefined> | null = null

  private readonly _steeringQueue: AgentEntry[] = []
  private readonly _followUpQueue: AgentEntry[] = []
  private readonly _listeners = new Set<(event: AgentEvent) => void>()

  // ── Runtime state ──────────────────────────────────────────────────────
  private _streamEntry:     AgentEntry | null = null
  private _streamText       = ''
  private _streamReasoning   = ''
  private _streamToolCalls: ToolCallInfo[] = []
  private _pendingToolCalls = new Set<string>()
  private _error:           string | null = null

  constructor(kernel: AgentKernel, options: AgentOptions) {
    this._kernel           = kernel
    this._stream           = options.stream
    this._tools            = options.tools
    this._maxSteps         = options.maxSteps
    this._transformContext = options.transformContext
    this._onStepEnd        = options.onStepEnd
    this._steeringMode     = options.steeringMode ?? 'one-at-a-time'
    this._followUpMode     = options.followUpMode ?? 'one-at-a-time'
    this._parallelTools    = options.parallelTools
    this._onContextFull    = options.onContextFull
    this._toolTimeout      = options.toolTimeout
    this._retryOnError     = options.retryOnError
  }

  // ── State ──────────────────────────────────────────────────────────────

  get kernel(): AgentKernel { return this._kernel }

  get state(): AgentState {
    return {
      isRunning:        this._abortController !== null,
      streamEntry:      this._streamEntry,
      pendingToolCalls: this._pendingToolCalls,
      error:            this._error,
    }
  }

  // ── Mutators ─────────────────────────────────────────────────────────────

  setStream(stream: StreamFn): void      { this._stream = stream }
  setTools(tools: AgentTool[]): void     { this._tools = tools }
  setMaxSteps(maxSteps: number): void    { this._maxSteps = maxSteps }
  setSteeringMode(mode: QueueMode): void { this._steeringMode = mode }
  setFollowUpMode(mode: QueueMode): void { this._followUpMode = mode }

  // ── Event subscription ──────────────────────────────────────────────────

  subscribe(fn: (event: AgentEvent) => void): () => void {
    this._listeners.add(fn)
    return () => { this._listeners.delete(fn) }
  }

  // ── Prompt ──────────────────────────────────────────────────────────────

  prompt(entries: AgentEntry | AgentEntry[]): void {
    if (this.state.isRunning) {
      throw new Error('Agent is already running. Use steer() or followUp() to queue messages.')
    }

    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      this._kernel.append(entry)
    }

    this._error = null
    this._run()
  }

  continue(): void {
    if (this.state.isRunning) {
      throw new Error('Agent is already running.')
    }

    const lastEntry = this._kernel.peek()
    if (!lastEntry) {
      throw new Error('No conversation to continue from. Use prompt() to start.')
    }

    const hasQueued = this._steeringQueue.length > 0 || this._followUpQueue.length > 0

    if (lastEntry.type === 'assistant') {
      const { stopReason } = lastEntry.payload
      const isRetriable = stopReason === 'error' || stopReason === 'aborted'
      if (!isRetriable && !hasQueued) {
        throw new Error('Nothing to continue from. Use prompt() to start a new turn.')
      }
    }

    this._error = null
    this._run()
  }

  // ── Steering / Follow-up ────────────────────────────────────────────────

  steer(entries: AgentEntry | AgentEntry[]): void {
    this._steeringQueue.push(...(Array.isArray(entries) ? entries : [entries]))
  }

  followUp(entries: AgentEntry | AgentEntry[]): void {
    this._followUpQueue.push(...(Array.isArray(entries) ? entries : [entries]))
  }

  // ── Abort ───────────────────────────────────────────────────────────────

  abort(): void {
    this._abortController?.abort()
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  reset(): void {
    if (this.state.isRunning) {
      throw new Error('Cannot reset while running. Call abort() first.')
    }

    this._steeringQueue.splice(0)
    this._followUpQueue.splice(0)
    this._streamEntry      = null
    this._streamText       = ''
    this._streamReasoning   = ''
    this._streamToolCalls  = []
    this._pendingToolCalls = new Set()
    this._error            = null
  }

  // ── Wait ────────────────────────────────────────────────────────────────

  async waitForIdle(): Promise<void> {
    if (this._runningPromise) {
      try { await this._runningPromise } catch { /* caller handles errors via subscribe */ }
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private _run(): void {
    this._abortController = new AbortController()

    const eventStream = runLoop(this._kernel, {
      stream:              this._stream,
      tools:               this._tools,
      maxSteps:            this._maxSteps,
      signal:              this._abortController.signal,
      transformContext:    this._transformContext,
      onStepEnd:           this._onStepEnd,
      getSteeringMessages: () => this._drainSteering(),
      getFollowUpMessages: () => this._drainFollowUp(),
      parallelTools:       this._parallelTools,
      onContextFull:       this._onContextFull,
      toolTimeout:         this._toolTimeout,
      retryOnError:        this._retryOnError,
    })

    this._runningPromise = this._consume(eventStream)
  }

  private async _consume(
    stream: AsyncIterable<AgentEvent> & { result(): Promise<AgentResult> },
  ): Promise<AgentResult | undefined> {
    try {
      for await (const event of stream) {
        this._handleEvent(event)
        for (const fn of this._listeners) {
          fn(event)
        }
      }
      return await stream.result()
    } catch {
      return undefined
    } finally {
      this._abortController = null
      this._runningPromise  = null
    }
  }

  private _handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'turn_start':
        this._streamText      = ''
        this._streamReasoning  = ''
        this._streamToolCalls = []
        this._streamEntry     = null
        break

      case 'text_delta':
        this._streamText += event.delta
        this._updateStreamEntry()
        break

      case 'reasoning_delta':
        this._streamReasoning += event.delta
        this._updateStreamEntry()
        break

      case 'tool_call':
        this._streamToolCalls.push({
          toolCallId: event.toolCallId,
          toolName:   event.toolName,
          input:      event.input,
        })
        this._pendingToolCalls.add(event.toolCallId)
        this._updateStreamEntry()
        break

      case 'tool_result':
        this._pendingToolCalls.delete(event.toolCallId)
        break

      case 'message_end':
        this._streamEntry = null
        break

      case 'turn_end':
        this._streamEntry = null
        break

      case 'agent_end':
        this._streamEntry      = null
        this._pendingToolCalls = new Set()
        if (event.error) {
          this._error = event.error
        }
        break
    }
  }

  private _updateStreamEntry(): void {
    this._streamEntry = {
      type:    'assistant',
      payload: {
        text:      this._streamText,
        reasoning:  this._streamReasoning || undefined,
        toolCalls: this._streamToolCalls,
      },
    }
  }

  private async _drainSteering(): Promise<AgentEntry[]> {
    if (this._steeringQueue.length === 0) return []
    return this._steeringMode === 'one-at-a-time'
      ? this._steeringQueue.splice(0, 1)
      : this._steeringQueue.splice(0)
  }

  private async _drainFollowUp(): Promise<AgentEntry[]> {
    if (this._followUpQueue.length === 0) return []
    return this._followUpMode === 'one-at-a-time'
      ? this._followUpQueue.splice(0, 1)
      : this._followUpQueue.splice(0)
  }
}

// ─── createAgent ──────────────────────────────────────────────────────────────

export interface AgentSessionOptions extends AgentOptions {
  /** Session persistence. Omit for in-memory mode (testing). */
  session?: { dir: string; sessionId: string; meta?: KernelOptions['meta'] }
}

export function createAgent(options: AgentSessionOptions): Agent {
  const { session, ...agentOptions } = options
  const kernel = createKernel(session)
  return new Agent(kernel, agentOptions)
}
