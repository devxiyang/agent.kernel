# agent-kernel

[![npm version](https://img.shields.io/npm/v/@devxiyang/agent-kernel)](https://www.npmjs.com/package/@devxiyang/agent-kernel)
[![npm downloads](https://img.shields.io/npm/dm/@devxiyang/agent-kernel)](https://www.npmjs.com/package/@devxiyang/agent-kernel)
[![license](https://img.shields.io/npm/l/@devxiyang/agent-kernel)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

A provider-agnostic agent runtime for TypeScript. Bring your own LLM — `agent-kernel` handles the loop, tool execution, event streaming, and conversation persistence.

## Features

- **Provider-agnostic** — implement one `StreamFn` adapter for any LLM backend (OpenAI, Anthropic, Vercel AI SDK, etc.)
- **Real-time event stream** — `text_delta`, `tool_call`, `tool_result`, `step_done`, and more
- **Typed tool execution** — TypeBox schemas drive runtime validation, coercion, and LLM schema generation
- **Parallel tool execution** — run all tool calls in a turn concurrently
- **Tool timeout** — per-call deadline; timed-out tools return an error result the LLM can handle
- **Persistent sessions** — optional file-backed conversation history, survives restarts
- **Conversation compaction** — replace old entries with a summary to stay within context limits
- **Auto-compaction hook** — `onContextFull` fires when the token budget is reached
- **Steering & follow-up** — inject messages mid-run; steering immediately aborts all running tools via `AbortSignal`
- **Stream error retry** — automatic retry with configurable delay for transient LLM errors
- **Session metadata** — attach titles and custom fields to sessions; query with `listSessions`
- **Kernel cache** — LRU + TTL in-memory cache for session kernels

## Install

```bash
npm install @devxiyang/agent-kernel
```

`@sinclair/typebox` is a required peer dependency for tool parameter schemas:

```bash
npm install @sinclair/typebox
```

Optional — install the LLM SDK of your choice:

```bash
npm install openai             # OpenAI SDK
npm install ai @ai-sdk/openai  # Vercel AI SDK
```

## Quick Start

```ts
import { Type } from '@sinclair/typebox'
import { createAgent, type StreamFn, type AgentTool } from '@devxiyang/agent-kernel'

// 1. Implement StreamFn for your LLM provider (see adapter examples below)
const stream: StreamFn = async (messages, _tools, onEvent) => {
  const last = messages.filter((m) => m.role === 'user').at(-1)
  const reply = `Echo: ${typeof last?.content === 'string' ? last.content : '[multi-part]'}`
  onEvent({ type: 'text-delta', delta: reply })
  return {
    text: reply, toolCalls: [], stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
             cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
}

// 2. Define tools
const tools: AgentTool[] = [
  {
    name:        'get_time',
    description: 'Returns the current UTC time as an ISO string.',
    parameters:  Type.Object({}),
    execute: async () => ({ content: new Date().toISOString(), isError: false }),
  },
]

// 3. Create agent and subscribe to events
const agent = createAgent({ stream, tools, maxSteps: 8 })

agent.subscribe((event) => {
  if (event.type === 'text_delta') process.stdout.write(event.delta)
})

// 4. Send a message and wait for completion
agent.prompt({ type: 'user', payload: { parts: [{ type: 'text', text: 'What time is it?' }] } })
await agent.waitForIdle()
```

## Module Index

| Import path | Contents |
|---|---|
| `@devxiyang/agent-kernel` | `Agent`, `createAgent`, `runLoop`, `wrapTool`, `EventStream`, all types |
| `@devxiyang/agent-kernel/agent` | Agent module only |
| `@devxiyang/agent-kernel/kernel` | `createKernel`, `KernelCache`, `listSessions`, `deleteSession`, `updateSessionMeta`, kernel types |
| `@devxiyang/agent-kernel/event-stream` | `EventStream` |

## Core Concepts

| Concept | Description |
|---|---|
| `Agent` | Stateful runtime — orchestrates the model loop, tool execution, and event emission |
| `Kernel` | Conversation store (in-memory or file-backed) with branching and compaction |
| `KernelCache` | LRU + TTL cache for reusing kernel instances across requests |
| `StreamFn` | Provider adapter — one function that calls your LLM and emits stream events |
| `AgentTool` | Executable unit with a TypeBox schema for validation and provider schema generation |
| `EventStream` | Async-iterable push stream primitive used internally by the loop |

---

## Agent API

### Sending messages

```ts
// Start a new run (throws if agent is already running)
agent.prompt(entry)

// Send a message — the agent decides whether to start a new run or queue it
// Safe to call whether the agent is idle or running
agent.followUp(entry)
```

Use `followUp` when you don't want to manage the agent's running state yourself. It starts a new run when idle and queues the message for the next run otherwise. `prompt` is a lower-level method that gives you explicit control: it throws if the agent is already running, forcing you to decide between `followUp` and `steer`.

### Steering (mid-run interruption)

`steer` injects a message that interrupts the current run immediately. Unlike `followUp`, it does not wait for the run to finish.

```ts
// Safe to call while the agent is running
agent.steer({ type: 'user', payload: { parts: [{ type: 'text', text: 'Actually, focus only on security.' }] } })
```

When `steer` is called, the agent **immediately signals all running tools to abort** via `AbortSignal`. Tools that respect the signal stop early; the remaining tool calls in the batch are skipped (writing `"Skipped: user interrupted."` results to keep the conversation consistent). The steering message is then processed in the next LLM step.

> **Tool contract**: `AgentTool.execute` receives a required `signal: AbortSignal`. Tools **must** propagate this signal to any I/O (fetch, child processes, etc.) and check it in long-running loops. A tool that ignores the signal will run to completion before the loop can proceed — treat this as an implementation bug in the tool.

**`steer` vs `followUp`**

| | `followUp` | `steer` |
|---|---|---|
| When processed | After the current run ends | Immediately; aborts running tools |
| Effect | Continues the outer loop | Interrupts the current tool batch |
| Use case | Next user turn | Real-time redirection mid-task |

### Waiting for completion

```ts
await agent.waitForIdle()
```

Resolves when the agent is truly idle — no running loop and no queued follow-up messages. Useful in request-response contexts (e.g., IPC handlers) where the caller needs to wait for all events to be dispatched before returning.

```ts
// IPC handler pattern
async function handleMessage(entry: AgentEntry) {
  agent.followUp(entry)
  await agent.waitForIdle()
  // all events have been dispatched to subscribers
}
```

If a subscriber calls `followUp` inside an `agent_end` handler, `waitForIdle` will continue waiting for that follow-up run to finish as well.

### Recovery

```ts
// Resume after an error or abort, or drain queued follow-up/steering messages
// Throws if already running or nothing to continue from
agent.continue()
```

### Aborting and resetting

```ts
agent.abort()   // cancel the current run (no-op if idle)
agent.reset()   // clear all queues and transient state (throws if running)
```

### Subscribing to events

```ts
const unsubscribe = agent.subscribe((event) => {
  switch (event.type) {
    case 'agent_start':   /* run began */ break
    case 'turn_start':    /* LLM call starting */ break
    case 'text_delta':    /* streaming text chunk */ break
    case 'reasoning_delta': /* streaming reasoning chunk */ break
    case 'tool_call':     /* tool invocation */ break
    case 'tool_update':   /* partial tool progress */ break
    case 'tool_result':   /* tool finished */ break
    case 'message_end':   /* assistant message committed */ break
    case 'step_done':     /* step usage stats */ break
    case 'turn_end':      /* turn finished with tool results */ break
    case 'agent_end':     /* run finished (check event.error) */ break
  }
})

// Stop receiving events
unsubscribe()
```

### Inspecting state

```ts
const { isRunning, streamEntry, pendingToolCalls, error } = agent.state

// Access the underlying kernel
const entries = agent.kernel.read()
```

---

## Kernel

The `Kernel` is the conversation store. It holds the full message history as an in-memory linked tree and optionally persists it to `kernel.jsonl`.

### Creating a kernel

```ts
import { createKernel } from '@devxiyang/agent-kernel/kernel'

// In-memory only (useful for testing)
const kernel = createKernel()

// File-backed — loads from disk if session exists
const kernel = createKernel({
  dir:       './.agent-sessions',
  sessionId: 'my-session',
  meta:      { title: 'Code review assistant' },
})
```

### Reading conversation history

```ts
// All entries on the current branch (root → leaf)
const entries = kernel.read()

// Most recent entry (or null if empty)
const last = kernel.peek()

// Build provider-agnostic messages for passing to StreamFn
const messages = kernel.buildMessages()
```

### Appending entries

```ts
kernel.append({ type: 'user', payload: { parts: [{ type: 'text', text: 'Hello' }] } })
```

The `Agent` calls `append` automatically during the loop. Call it directly only when working with a bare kernel outside of an agent.

### Context budget

```ts
// Set a token limit; onContextFull fires when contextSize >= limit
kernel.budget.set(80_000)

console.log(kernel.contextSize)  // input tokens from the last assistant entry
console.log(kernel.budget.limit) // current limit
console.log(kernel.budget.used)  // same as contextSize
```

### Compaction

Replace a range of entries with a summary to reduce context size:

```ts
const entries = kernel.read()
// Compact the first half of the conversation
kernel.compact(
  entries[0].id,
  entries[Math.floor(entries.length / 2)].id,
  'Summary: discussed project setup and requirements.',
)
```

Compaction rewrites `kernel.jsonl` to the clean current branch and appends a divider to `log.jsonl`.

### Branching

```ts
// Rewind the conversation to a past entry (discards entries after toId in memory)
kernel.branch(toId)
```

### Session files

Each session writes three files to `<dir>/<sessionId>/`:

| File | Contents |
|---|---|
| `kernel.jsonl` | Current branch only; rewritten on compaction |
| `log.jsonl` | Append-only full history; never compacted; used for UI display |
| `meta.json` | Session metadata (`createdAt`, `title`, custom fields) |

---

## KernelCache

When an agent handles multiple sessions, recreating a `Kernel` from `kernel.jsonl` on every request adds unnecessary I/O. `KernelCache` keeps hot kernels in memory with LRU eviction and TTL expiry.

```ts
import { KernelCache } from '@devxiyang/agent-kernel/kernel'

const cache = new KernelCache({
  dir:     './.agent-sessions',
  maxSize: 100,           // keep at most 100 kernels in memory (default: 50)
  ttl:     15 * 60_000,   // evict after 15 min of inactivity (default: 30 min)
})
```

### Per-request pattern

```ts
async function handleRequest(sessionId: string, text: string) {
  // Kernel is reused across requests; Agent is lightweight, created fresh each time
  const kernel = cache.get(sessionId)
  const agent  = new Agent(kernel, { stream, tools, maxSteps: 8 })

  agent.subscribe(event => { /* forward events to client */ })

  agent.followUp({ type: 'user', payload: { parts: [{ type: 'text', text }] } })
  await agent.waitForIdle()
}
```

The `Agent` is cheap to construct (no I/O, no async work) so creating one per request is fine. Only the `Kernel` — which holds the in-memory conversation tree — benefits from caching.

### Cache API

```ts
// Get or create a kernel for sessionId; updates LRU order and resets TTL
const kernel = cache.get(sessionId)

// Optionally pass metadata written to meta.json on first creation
const kernel = cache.get(sessionId, { title: 'My session' })

// Remove a specific session from cache (kernel.jsonl is not touched)
cache.evict(sessionId)

// Remove all cached kernels
cache.clear()

// Number of kernels currently cached
cache.size
```

---

## Persistent Sessions

```ts
import { createAgent } from '@devxiyang/agent-kernel'

const agent = createAgent({
  stream, tools, maxSteps: 8,
  session: {
    dir:       './.agent-sessions',
    sessionId: 'my-session',
    meta:      { title: 'Code review assistant' },
  },
})

agent.prompt({ type: 'user', payload: { parts: [{ type: 'text', text: 'Summarize our last discussion.' }] } })
await agent.waitForIdle()

// Manual compaction when context grows
const entries = agent.kernel.read()
if (entries.length > 12) {
  agent.kernel.compact(entries[0].id, entries[8].id, 'Summary of earlier context.')
}
```

## Session Management

```ts
import { listSessions, deleteSession, updateSessionMeta } from '@devxiyang/agent-kernel/kernel'

// List all sessions, sorted by most recently updated
const sessions = listSessions('./.agent-sessions')
// [
//   { sessionId: 'my-session', updatedAt: 1740000000000, messageCount: 12,
//     meta: { createdAt: 1739999000000, title: 'Code review assistant' } },
// ]

// Rename a session
updateSessionMeta('./.agent-sessions', 'my-session', { title: 'New title' })

// Delete a session
deleteSession('./.agent-sessions', 'my-session')
```

All functions are safe to call on non-existent paths — `listSessions` returns `[]`, the others are silent no-ops.

### `SessionInfo` type

```ts
type SessionMeta = {
  createdAt: number   // Unix ms — set once, never overwritten
  title?:    string
}

type SessionInfo = {
  sessionId:    string
  updatedAt:    number        // log.jsonl mtime in milliseconds
  messageCount: number        // entries in log.jsonl
  meta:         SessionMeta | null
}
```

---

## Defining Tools

TypeBox schemas in `parameters` drive both runtime validation and the JSON Schema passed to the LLM. The `execute` input type is inferred — no manual annotation needed.

The `signal: AbortSignal` parameter is **required** (changed in v0.1.0). Pass it to any underlying I/O so tools can be interrupted when the user calls `agent.steer()`.

```ts
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@devxiyang/agent-kernel'

const searchSchema = Type.Object({
  query: Type.String({ description: 'Search query string' }),
  limit: Type.Optional(Type.Number({ description: 'Max results (default 10)' })),
})

const searchTool: AgentTool<typeof searchSchema> = {
  name:        'search_docs',
  description: 'Search project documentation by query.',
  parameters:  searchSchema,
  execute: async (_toolCallId, input, signal) => {
    // input: { query: string; limit?: number }
    // Always propagate signal to I/O so steering can interrupt immediately
    const response = await fetch(`/search?q=${input.query}`, { signal })
    return {
      content:  `Found results for: ${input.query}`,
      isError:  false,
      details:  { hits: 3 },
    }
  },
}
```

Validation errors are returned as `isError: true` tool results so the LLM can self-correct.

---

## Implementing a `StreamFn`

```ts
type StreamFn = (
  messages: AgentMessage[],
  tools:    AgentTool[],
  onEvent:  (event: LLMStreamEvent) => void,
  signal?:  AbortSignal,
) => Promise<LLMStepResult>
```

The function receives the full conversation and tool list on every call. Use `tool.parameters` (plain JSON Schema) to generate provider-specific tool definitions.

---

## Adapter Examples

### OpenAI SDK

```ts
import OpenAI from 'openai'
import type { StreamFn, ToolCallInfo } from '@devxiyang/agent-kernel'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export const openaiStream: StreamFn = async (messages, tools, onEvent, signal) => {
  const response = await client.responses.create({
    model: 'gpt-4o',
    input: messages.map((m) => ({
      role:    m.role as 'user' | 'assistant' | 'tool',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    })),
    tools: tools.map((t) => ({
      type:        'function' as const,
      name:        t.name,
      description: t.description,
      parameters:  t.parameters ?? { type: 'object', properties: {} },
    })),
    signal,
  })

  let text = ''
  const toolCalls: ToolCallInfo[] = []

  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') {
          text += part.text
          onEvent({ type: 'text-delta', delta: part.text })
        }
      }
    }
    if (item.type === 'function_call') {
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(item.arguments ?? '{}') } catch { /* ignore */ }
      const tc = { toolCallId: item.call_id ?? item.id, toolName: item.name, input }
      toolCalls.push(tc)
      onEvent({ type: 'tool-call', ...tc })
    }
  }

  const inputTokens  = response.usage?.input_tokens  ?? 0
  const outputTokens = response.usage?.output_tokens ?? 0

  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
    usage: {
      input:       inputTokens,
      output:      outputTokens,
      cacheRead:   0,
      cacheWrite:  0,
      totalTokens: response.usage?.total_tokens ?? inputTokens + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}
```

### Vercel AI SDK

```ts
import { streamText, jsonSchema, tool } from 'ai'
import { openai } from '@ai-sdk/openai'
import type { StreamFn, ToolCallInfo } from '@devxiyang/agent-kernel'

export const aiSdkStream: StreamFn = async (messages, tools, onEvent, signal) => {
  const aiTools = Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: t.parameters ? jsonSchema(t.parameters) : jsonSchema({ type: 'object', properties: {} }),
      }),
    ]),
  )

  const result = streamText({
    model:       openai('gpt-4o'),
    messages:    messages.map((m) => ({
      role:    m.role as 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    })),
    tools:       aiTools,
    maxSteps:    1,
    abortSignal: signal,
  })

  let text = ''
  const toolCalls: ToolCallInfo[] = []

  for await (const chunk of result.fullStream) {
    if (chunk.type === 'text-delta') {
      text += chunk.textDelta
      onEvent({ type: 'text-delta', delta: chunk.textDelta })
    }
    if (chunk.type === 'tool-call') {
      const tc = { toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.input as Record<string, unknown> }
      toolCalls.push(tc)
      onEvent({ type: 'tool-call', ...tc })
    }
  }

  const usage = await result.usage

  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
    usage: {
      input:       usage.promptTokens,
      output:      usage.completionTokens,
      cacheRead:   0,
      cacheWrite:  0,
      totalTokens: usage.totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}
```

---

## Advanced Options

### Parallel Tool Execution

Run all tool calls in a turn concurrently. If a steering message arrives after execution, results are discarded and replaced with skipped markers.

```ts
const agent = createAgent({ stream, tools, maxSteps: 10, parallelTools: true })
```

### Tool Timeout

Per-call deadline in milliseconds. Timed-out tools return `isError: true` so the LLM can handle the failure.

```ts
const agent = createAgent({ stream, tools, maxSteps: 10, toolTimeout: 15_000 })
```

### Stream Error Retry

Retry transient LLM errors with a fixed delay. Abort signals are respected — no retry after abort.

```ts
const agent = createAgent({
  stream, tools, maxSteps: 10,
  retryOnError: { maxAttempts: 3, delayMs: 500 },
})
```

### Auto-Compaction (`onContextFull`)

Fires after a step when `kernel.contextSize >= kernel.budget.limit`. Set `kernel.budget` to activate.

```ts
const agent = createAgent({
  stream, tools, maxSteps: 10,
  onContextFull: async (kernel) => {
    const entries = kernel.read()
    kernel.compact(entries[0].id, entries[Math.floor(entries.length / 2)].id, 'Earlier context summarised.')
  },
})

agent.kernel.budget.set(80_000) // trigger at 80 k input tokens
```

---

## Tool Hooks (`wrapTool`)

Intercept tool calls before or after execution without modifying the original tool.

```ts
import { wrapTool } from '@devxiyang/agent-kernel'

const guardedTool = wrapTool(myTool, {
  before: async (toolCallId, toolName, input) => {
    if (!isAllowed(input)) return { action: 'block', reason: 'Not permitted.' }
  },
  after: async (toolCallId, toolName, result) => {
    return { content: redact(result.content) }
  },
})
```

`before` can return `{ action: 'block', reason }` to skip execution; the reason is returned as `isError: true`. `after` can override `content`, `isError`, or `details`.

---

## Build & Test

```bash
npm run build      # compile TypeScript → dist/
npm run typecheck  # type-check without emitting
npm test           # run unit tests (vitest)
npm run test:watch # watch mode
```

## License

[MIT](./LICENSE)
