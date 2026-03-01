import { describe, it, expect, vi } from 'vitest'
import { Type } from '@sinclair/typebox'
import { wrapTool } from '../../../src/core/agent/wrap-tool.js'
import type { AgentTool, ToolResult } from '../../../src/core/agent/types.js'

function makeTool(result: ToolResult = { content: 'ok', isError: false }): AgentTool {
  return {
    name:        'myTool',
    description: 'A test tool',
    execute:     vi.fn().mockResolvedValue(result),
  }
}

describe('wrapTool', () => {
  it('executes the underlying tool when no hooks are provided', async () => {
    const tool = makeTool()
    const wrapped = wrapTool(tool, {})
    const result = await wrapped.execute('call-1', {}, undefined, undefined)
    expect(result).toEqual({ content: 'ok', isError: false })
    expect(tool.execute).toHaveBeenCalledOnce()
  })

  it('before hook returning void allows normal execution', async () => {
    const tool = makeTool()
    const before = vi.fn().mockResolvedValue(undefined)
    const wrapped = wrapTool(tool, { before })
    const result = await wrapped.execute('call-1', {}, undefined, undefined)
    expect(before).toHaveBeenCalledWith('call-1', 'myTool', {})
    expect(result.isError).toBe(false)
    expect(tool.execute).toHaveBeenCalledOnce()
  })

  it('before hook with action:block skips execution and returns error', async () => {
    const tool = makeTool()
    const wrapped = wrapTool(tool, {
      before: async () => ({ action: 'block', reason: 'not allowed' }),
    })
    const result = await wrapped.execute('call-1', {}, undefined, undefined)
    expect(result.isError).toBe(true)
    expect(result.content).toBe('not allowed')
    expect(tool.execute).not.toHaveBeenCalled()
  })

  it('after hook can override content', async () => {
    const tool = makeTool({ content: 'original', isError: false })
    const wrapped = wrapTool(tool, {
      after: async () => ({ content: 'overridden' }),
    })
    const result = await wrapped.execute('call-1', {}, undefined, undefined)
    expect(result.content).toBe('overridden')
    expect(result.isError).toBe(false)
  })

  it('after hook can override isError', async () => {
    const tool = makeTool({ content: 'result', isError: false })
    const wrapped = wrapTool(tool, {
      after: async () => ({ isError: true }),
    })
    const result = await wrapped.execute('call-1', {}, undefined, undefined)
    expect(result.isError).toBe(true)
    expect(result.content).toBe('result')
  })

  it('after hook returning void keeps original result', async () => {
    const tool = makeTool({ content: 'original', isError: false })
    const wrapped = wrapTool(tool, {
      after: async () => undefined,
    })
    const result = await wrapped.execute('call-1', {}, undefined, undefined)
    expect(result.content).toBe('original')
  })

  it('after hook can set details', async () => {
    const tool = makeTool({ content: 'data', isError: false })
    const wrapped = wrapTool(tool, {
      after: async () => ({ details: { extra: 42 } }),
    })
    const result = await wrapped.execute('call-1', {}, undefined, undefined)
    expect((result.details as { extra: number }).extra).toBe(42)
  })

  it('both before and after hooks are called', async () => {
    const tool = makeTool()
    const before = vi.fn().mockResolvedValue(undefined)
    const after  = vi.fn().mockResolvedValue(undefined)
    const wrapped = wrapTool(tool, { before, after })
    await wrapped.execute('call-1', {}, undefined, undefined)
    expect(before).toHaveBeenCalledOnce()
    expect(after).toHaveBeenCalledOnce()
  })

  it('preserves tool name and description', () => {
    const tool = makeTool()
    const wrapped = wrapTool(tool, {})
    expect(wrapped.name).toBe('myTool')
    expect(wrapped.description).toBe('A test tool')
  })

  it('preserves tool parameters schema', () => {
    const schema = Type.Object({ q: Type.String() })
    const tool: AgentTool = {
      name:        'search',
      description: 'Search',
      parameters:  schema,
      execute:     vi.fn().mockResolvedValue({ content: '', isError: false }),
    }
    const wrapped = wrapTool(tool, {})
    expect(wrapped.parameters).toBe(schema)
  })
})
