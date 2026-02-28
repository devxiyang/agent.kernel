# agent-kernel

`agent-kernel` is a TypeScript library that provides a provider-agnostic agent runtime:
- a persistent/in-memory conversation kernel
- an event-driven agent loop with tool execution
- a reusable async event stream primitive

## What This Package Includes

- `Agent` and `createAgent`: stateful runtime wrapper for prompting, steering, follow-up, and abort control
- `runLoop`: low-level agent loop that streams events and executes tools
- `createKernel`: conversation storage with branching, compaction, and message building
- `EventStream`: generic push/iterate async stream utility
- shared runtime and type definitions for messages, usage, tools, and events

## Project Structure

```text
src/
  core/
    agent/
    kernel/
  event-stream.ts
  index.ts
```

## Install

```bash
npm install agent-kernel
```

## Development

```bash
npm install
npm run typecheck
npm run build
```

## Exports

- `agent-kernel`
  - root export (agent APIs + `EventStream`)
- `agent-kernel/agent`
  - direct agent module
- `agent-kernel/kernel`
  - kernel module (`createKernel`, kernel types)
- `agent-kernel/event-stream`
  - `EventStream`

## Quick Example

```ts
import { createAgent } from 'agent-kernel'

const agent = createAgent({
  stream: async () => ({
    text: 'hello',
    toolCalls: [],
    stopReason: 'stop',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }),
  tools: [],
  maxSteps: 8,
})
```

## Build Output

Compiled files and type declarations are generated into `dist/`.
