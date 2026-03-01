/**
 * @module agent-kernel/agent
 *
 * Public surface of the Agent module. Exports all types, the Agent class,
 * the createAgent factory, the low-level runLoop function, and the wrapTool helper.
 */

export type {
  Usage,
  AgentEntry,
  AgentMessage,
  StopReason,
  ToolCallInfo,
} from '../kernel'

export type {
  ToolContent,
  ToolResult,
  ToolResultInfo,
  LLMStreamEvent,
  LLMStopReason,
  LLMStepResult,
  StreamFn,
  AgentTool,
  AgentConfig,
  AgentEvent,
  AgentResult,
  AgentOptions,
  QueueMode,
  BlockResult,
  BeforeToolCallResult,
  BeforeToolCallHook,
  AfterToolCallResult,
  AfterToolCallHook,
  ToolWrapHooks,
} from './types'

export { Agent, createAgent } from './agent'
export type { AgentState, AgentSessionOptions } from './agent'
export { runLoop } from './loop'
export { wrapTool } from './wrap-tool'
