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
- **Steering & follow-up** — inject messages mid-run without re-prompting
- **Stream error retry** — automatic retry with configurable delay for transient LLM errors
- **Session metadata** — attach titles and custom fields to sessions; query with `listSessions`

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

// Implement StreamFn once for your LLM provider (see adapter examples below)
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

const tools: AgentTool[] = [
  {
    name:        'get_time',
    description: 'Returns the current UTC time as an ISO string.',
    parameters:  Type.Object({}),
    execute: async () => ({ content: new Date().toISOString(), isError: false }),
  },
]

const agent = createAgent({ stream, tools, maxSteps: 8 })

agent.subscribe((event) => {
  if (event.type === 'text_delta') process.stdout.write(event.delta)
})

agent.prompt({ type: 'user', payload: { parts: [{ type: 'text', text: 'What time is it?' }] } })
await agent.waitForIdle()
```

## Module Index

| Import path | Contents |
|---|---|
| `@devxiyang/agent-kernel` | `Agent`, `createAgent`, `runLoop`, `wrapTool`, `EventStream`, all types |
| `@devxiyang/agent-kernel/agent` | Agent module only |
| `@devxiyang/agent-kernel/kernel` | `createKernel`, `listSessions`, `deleteSession`, `updateSessionMeta`, kernel types |
| `@devxiyang/agent-kernel/event-stream` | `EventStream` |

## Core Concepts

| Concept | Description |
|---|---|
| `Agent` | Stateful runtime — orchestrates the model loop, tool execution, and event emission |
| `Kernel` | Conversation store (in-memory or file-backed) with branching and compaction |
| `StreamFn` | Provider adapter — one function that calls your LLM and emits stream events |
| `AgentTool` | Executable unit with a TypeBox schema for validation and provider schema generation |
| `EventStream` | Async-iterable push stream primitive used internally by the loop |

---

## Defining Tools

TypeBox schemas in `parameters` drive both runtime validation and the JSON Schema passed to the LLM. The `execute` input type is inferred — no manual annotation needed.

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
  execute: async (_toolCallId, input) => {
    // input: { query: string; limit?: number }
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

### Steering & Follow-up

Inject messages into a running or idle agent without re-prompting.

```ts
// Picked up on the next loop iteration
agent.steer({ type: 'user', payload: { parts: [{ type: 'text', text: 'Focus on security.' }] } })

// Triggers another run after the current one ends
agent.followUp({ type: 'user', payload: { parts: [{ type: 'text', text: 'Now summarise.' }] } })
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

Session files are written to `./.agent-sessions/<sessionId>/` (`kernel.jsonl`, `log.jsonl`, `meta.json`).

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
