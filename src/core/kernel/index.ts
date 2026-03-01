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
  AgentEntry,
  AgentMessage,
  StoredEntry,
  AppendResult,
  CompactionEntry,
  TokenBudget,
  AgentKernel,
  KernelOptions,
  SessionMeta,
} from './types'

export { COMPACTION_TYPE } from './types'

export { createKernel } from './kernel'

export type { SessionInfo } from './session-store'
export { listSessions, deleteSession, updateSessionMeta } from './session-store'
