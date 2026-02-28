import type { TObject } from '@sinclair/typebox'
import type {
  AgentTool,
  BlockResult,
  ToolResult,
  ToolWrapHooks,
} from './types'

/**
 * Wrap an AgentTool with before/after hooks.
 *
 * - `before`: can block, modify input, or replace the result entirely
 * - `after`: can partially override content, isError, and/or details
 *
 * Hooks are transparent to the agent loop — the loop only sees a plain AgentTool.
 */
export function wrapTool<
  TSchema  extends TObject = TObject,
  TDetails = unknown,
>(
  tool:  AgentTool<TSchema, TDetails>,
  hooks: ToolWrapHooks,
): AgentTool<TSchema, TDetails> {
  return {
    ...tool,
    execute: async (toolCallId, input, signal, onUpdate) => {
      // ── before hook ──────────────────────────────────────────────────────
      if (hooks.before) {
        const before = await hooks.before(toolCallId, tool.name, input)
        if (before?.action === 'block') {
          return { content: (before as BlockResult).reason, isError: true } as ToolResult<TDetails>
        }
      }

      // ── execute ──────────────────────────────────────────────────────────
      let result: ToolResult<TDetails> = await tool.execute(toolCallId, input, signal, onUpdate)

      // ── after hook ───────────────────────────────────────────────────────
      if (hooks.after) {
        const after = await hooks.after(toolCallId, tool.name, result)
        if (after) {
          result = {
            content:  after.content  !== undefined ? after.content              : result.content,
            isError:  after.isError  !== undefined ? after.isError              : result.isError,
            details:  after.details  !== undefined ? after.details as TDetails  : result.details,
          }
        }
      }

      return result
    },
  }
}
