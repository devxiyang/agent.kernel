/**
 * @module agent-kernel/kernel
 *
 * Public surface of the Kernel module. Exports all types, the createKernel factory,
 * and session management utilities (listSessions, deleteSession, updateSessionMeta).
 */

export type {
  Usage,
  DataContent,
  TextPart,
  ImagePart,
  AudioPart,
  VideoPart,
  FilePart,
  ContentPart,
  ImageMediaType,
  AudioMediaType,
  VideoMediaType,
  FileMediaType,
  StopReason,
  ToolCallInfo,
  ReasoningPart,
  ToolCallPart,
  AssistantPart,
  AgentEntry,
  AgentMessage,
  StoredEntry,
  AppendResult,
  CompactionEntry,
  TokenBudget,
  AgentKernel,
  KernelOptions,
  ThreadMeta,
} from './types'

export { COMPACTION_TYPE } from './types'

export { createKernel } from './kernel'

export type { KernelCacheOptions } from './kernel-cache'
export { KernelCache } from './kernel-cache'

export type { ThreadInfo } from './thread-store'
export { listThreads, deleteThread, updateThreadMeta } from './thread-store'
