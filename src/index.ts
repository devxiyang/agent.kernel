/**
 * @module agent-kernel
 *
 * Package root. Re-exports the full public Agent API and the EventStream utility.
 *
 * Common imports:
 *   import { createAgent, wrapTool, type AgentTool } from '@devxiyang/agent-kernel'
 *   import { EventStream } from '@devxiyang/agent-kernel'
 */

export * from './core/agent'
export { EventStream } from './event-stream'
