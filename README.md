# agent-kernel

`agent-kernel` is a TypeScript library that provides a provider-agnostic agent runtime:
- a persistent/in-memory conversation kernel
- an event-driven agent loop with tool execution and parameter validation
- a reusable async event stream primitive

## Core Concepts

- `Agent`: stateful runtime that orchestrates model calls, tool execution, and event emission.
- `Kernel`: conversation state store (in-memory or persisted), with branching and compaction support.
- `StreamFn`: provider adapter contract — you implement it once for any LLM backend.
- `AgentTool`: executable unit with a TypeBox schema for parameter validation and provider schema generation.

## Project Structure

```text
src/
  core/
    agent/
    kernel/
  event-stream.ts
  index.ts
```

## Feature Map

- Provider-agnostic runtime via `StreamFn`
- Real-time events (`text_delta`, `tool_call`, `tool_result`, `step_done`, etc.)
- Tool execution loop with automatic parameter validation (TypeBox + `Value.Parse`)
- Validation errors returned as `tool_result` so the LLM can self-correct
- Persistent sessions via `createAgent({ session: { dir, sessionId } })`
- Conversation compaction via `kernel.compact(fromId, toId, summaryText)`
- Strong TypeScript types — `execute` input is inferred from the TypeBox schema

## Install

```bash
npm install @devxiyang/agent-kernel
npm install @sinclair/typebox
npm install openai             # if using OpenAI SDK adapter
npm install ai @ai-sdk/openai  # if using Vercel AI SDK adapter
```

## Module Index

- `@devxiyang/agent-kernel` — root export (agent APIs + `EventStream`)
- `@devxiyang/agent-kernel/agent` — direct agent module
- `@devxiyang/agent-kernel/kernel` — kernel module (`createKernel`, kernel types)
- `@devxiyang/agent-kernel/event-stream` — `EventStream`

---

## Quick Start

```ts
import { Type } from '@sinclair/typebox'
import { createAgent, type StreamFn, type AgentTool } from '@devxiyang/agent-kernel'

// Minimal echo stream (replace with a real provider adapter)
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

const getTimeSchema = Type.Object({})

const tools: AgentTool[] = [
  {
    name:        'get_time',
    description: 'Returns the current UTC time as an ISO string.',
    parameters:  getTimeSchema,
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

---

## Defining Tools

Tools carry their TypeBox schema in `parameters`. The loop validates and coerces LLM-supplied
arguments before calling `execute`; validation errors are returned as `tool_result` so the LLM
can retry with corrected parameters.

```ts
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@devxiyang/agent-kernel'

const searchSchema = Type.Object({
  query: Type.String({ description: 'Search query string' }),
  limit: Type.Optional(Type.Number({ description: 'Max results (default 10)' })),
})

// typeof searchSchema drives the input type — no manual annotation needed
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

`parameters` is a standard JSON Schema at runtime (TypeBox schemas are JSON Schema), so
provider adapters can pass `tool.parameters` directly to any LLM API.

---

## Implementing a `StreamFn`

`StreamFn` receives the current conversation messages and the full tool list on every call.
Use `tools` to generate the provider-specific schema — no hardcoding needed.

```ts
type StreamFn = (
  messages: AgentMessage[],
  tools:    AgentTool[],
  onEvent:  (event: LLMStreamEvent) => void,
  signal?:  AbortSignal,
) => Promise<LLMStepResult>
```

---

## Example: OpenAI SDK Adapter

Uses the OpenAI Responses API. Tools are converted from TypeBox schemas on every call.

```ts
import OpenAI from 'openai'
import type { AgentMessage, StreamFn, ToolCallInfo } from '@devxiyang/agent-kernel'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

function toOpenAIMessages(messages: AgentMessage[]) {
  return messages.map((m) => ({
    role:    m.role as 'user' | 'assistant' | 'tool',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }))
}

export const openaiStream: StreamFn = async (messages, tools, onEvent, signal) => {
  const response = await client.responses.create({
    model: 'gpt-4o',
    input: toOpenAIMessages(messages),
    // TypeBox schemas are plain JSON Schema — pass them directly
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

// Usage
import { Type } from '@sinclair/typebox'
import { createAgent } from '@devxiyang/agent-kernel'

const searchSchema = Type.Object({
  query: Type.String({ description: 'Search query string' }),
})

const agent = createAgent({
  stream: openaiStream,
  tools: [
    {
      name:        'search_docs',
      description: 'Search project documentation by query.',
      parameters:  searchSchema,
      execute: async (_id, input) => ({
        content:  `Results for: ${input.query}`,
        isError:  false,
      }),
    },
  ],
  maxSteps: 10,
})

agent.subscribe((e) => { if (e.type === 'text_delta') process.stdout.write(e.delta) })
agent.prompt({ type: 'user', payload: { parts: [{ type: 'text', text: 'Find compact API docs' }] } })
await agent.waitForIdle()
```

---

## Example: Vercel AI SDK v6 Adapter

Uses `streamText` from `ai`. Tools without an `execute` function are returned as tool calls
for our loop to handle. `jsonSchema()` wraps TypeBox schemas as AI SDK-compatible schemas.

```ts
import { streamText, jsonSchema, tool } from 'ai'
import { openai } from '@ai-sdk/openai'
import type { AgentMessage, StreamFn, ToolCallInfo } from '@devxiyang/agent-kernel'

function toAISDKMessages(messages: AgentMessage[]) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      // tool_result entries — AI SDK expects role 'tool'
      const payload = m.content as { toolCallId: string; content: string }
      return { role: 'tool' as const, content: [{ type: 'tool-result' as const, toolCallId: payload.toolCallId, result: payload.content }] }
    }
    return {
      role:    m.role as 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }
  })
}

export const aiSdkStream: StreamFn = async (messages, tools, onEvent, signal) => {
  // Build AI SDK tool definitions — no execute, our loop handles execution
  const aiTools = Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        // jsonSchema() accepts any plain JSON Schema — TypeBox schemas qualify
        inputSchema: t.parameters ? jsonSchema(t.parameters) : jsonSchema({ type: 'object', properties: {} }),
      }),
    ]),
  )

  const result = streamText({
    model:       openai('gpt-4o'),
    messages:    toAISDKMessages(messages),
    tools:       aiTools,
    maxSteps:    1,          // one LLM call per StreamFn invocation; our kernel loops
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

// Usage
import { Type } from '@sinclair/typebox'
import { createAgent } from '@devxiyang/agent-kernel'

const searchSchema = Type.Object({
  query: Type.String({ description: 'Search query string' }),
})

const agent = createAgent({
  stream: aiSdkStream,
  tools: [
    {
      name:        'search_docs',
      description: 'Search project documentation by query.',
      parameters:  searchSchema,
      execute: async (_id, input) => ({
        content:  `Results for: ${input.query}`,
        isError:  false,
      }),
    },
  ],
  maxSteps: 10,
})

agent.subscribe((e) => { if (e.type === 'text_delta') process.stdout.write(e.delta) })
agent.prompt({ type: 'user', payload: { parts: [{ type: 'text', text: 'Find compact API docs' }] } })
await agent.waitForIdle()
```

---

## Persistent Session + Kernel Compaction

```ts
import { createAgent } from '@devxiyang/agent-kernel'

const agent = createAgent({
  stream:   openaiStream,   // or aiSdkStream
  tools:    [],
  maxSteps: 8,
  session: {
    dir:       './.agent-sessions',
    sessionId: 'demo-session-001',
  },
})

agent.prompt({ type: 'user', payload: { parts: [{ type: 'text', text: 'Summarize our last discussion.' }] } })
await agent.waitForIdle()

// Compact old entries when context grows
const entries = agent.kernel.read()
if (entries.length > 12) {
  const fromId = entries[0].id
  const toId   = entries[Math.min(8, entries.length - 1)].id
  agent.kernel.compact(fromId, toId, 'Summary of earlier context and decisions.')
}
```

Session files are written under `./.agent-sessions/<sessionId>/` (`kernel.jsonl`, `log.jsonl`).

---

## Build Output

Compiled files and type declarations are generated into `dist/`.

```bash
npm run build
npm run typecheck
```
