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

/**
 * High-level stateful agent.
 *
 * Owns the AbortController lifecycle, steering/follow-up queues, event fan-out
 * to subscribers, and mutable config. The underlying kernel (conversation store)
 * is created externally and injected — the Agent never touches persistence directly.
 */
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

  /** The underlying kernel that owns conversation history and persistence. */
  get kernel(): AgentKernel { return this._kernel }

  /** Snapshot of the current runtime state (read-only). */
  get state(): AgentState {
    return {
      isRunning:        this._abortController !== null,
      streamEntry:      this._streamEntry,
      pendingToolCalls: this._pendingToolCalls,
      error:            this._error,
    }
  }

  // ── Mutators ─────────────────────────────────────────────────────────────

  /** Replace the LLM streaming function (takes effect on the next run). */
  setStream(stream: StreamFn): void      { this._stream = stream }
  /** Replace the tool set (takes effect on the next run). */
  setTools(tools: AgentTool[]): void     { this._tools = tools }
  /** Update the maximum number of loop steps (takes effect on the next run). */
  setMaxSteps(maxSteps: number): void    { this._maxSteps = maxSteps }
  /** Change how many steering messages are dequeued per check. */
  setSteeringMode(mode: QueueMode): void { this._steeringMode = mode }
  /** Change how many follow-up messages are dequeued per check. */
  setFollowUpMode(mode: QueueMode): void { this._followUpMode = mode }

  // ── Event subscription ──────────────────────────────────────────────────

  /**
   * Register a listener for all agent events.
   * Returns an unsubscribe function — call it to stop receiving events.
   */
  subscribe(fn: (event: AgentEvent) => void): () => void {
    this._listeners.add(fn)
    return () => { this._listeners.delete(fn) }
  }

  // ── Prompt ──────────────────────────────────────────────────────────────

  /**
   * Append one or more user entries to the kernel and start a new agent run.
   * Throws if the agent is already running — use steer() or followUp() instead.
   */
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

  /**
   * Resume execution after an error, abort, or when steering/follow-up messages
   * are queued but the loop has already exited.
   * Throws if already running or if there is nothing to continue from.
   */
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

  /**
   * Queue a steering message that interrupts the current run between tool calls.
   * Safe to call while the agent is running. The loop picks it up on the next
   * steering check and skips any remaining tool calls in the current batch.
   */
  steer(entries: AgentEntry | AgentEntry[]): void {
    this._steeringQueue.push(...(Array.isArray(entries) ? entries : [entries]))
  }

  /**
   * Queue a follow-up message to be processed after the current run completes.
   * Causes the outer loop to continue rather than stop when the agent would
   * otherwise go idle.
   */
  followUp(entries: AgentEntry | AgentEntry[]): void {
    this._followUpQueue.push(...(Array.isArray(entries) ? entries : [entries]))
  }

  // ── Abort ───────────────────────────────────────────────────────────────

  /** Cancel the current run. No-op if not running. */
  abort(): void {
    this._abortController?.abort()
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  /**
   * Clear all queues and transient runtime state (stream entry, pending tool calls, error).
   * Does NOT touch the kernel or conversation history.
   * Throws if called while running — abort() first.
   */
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

  /** Resolves when the agent finishes its current run (or immediately if idle). */
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

/**
 * Convenience factory that creates a kernel (optionally with persistence) and
 * wraps it in an Agent. Prefer this over constructing Agent directly.
 */
export function createAgent(options: AgentSessionOptions): Agent {
  const { session, ...agentOptions } = options
  const kernel = createKernel(session)
  return new Agent(kernel, agentOptions)
}
