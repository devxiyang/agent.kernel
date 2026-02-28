import { describe, it, expect } from 'vitest'
import { EventStream } from './event-stream.js'

describe('EventStream', () => {
  it('pushes events that are consumed by async iteration', async () => {
    const stream = new EventStream<number, string>()
    stream.push(1)
    stream.push(2)
    stream.push(3)
    stream.end('done')

    const events: number[] = []
    for await (const e of stream) {
      events.push(e)
    }
    expect(events).toEqual([1, 2, 3])
    await expect(stream.result()).resolves.toBe('done')
  })

  it('resolves result() with value passed to end()', async () => {
    const stream = new EventStream<never, number>()
    stream.end(42)
    await expect(stream.result()).resolves.toBe(42)
  })

  it('rejects result() when error() is called', async () => {
    const stream = new EventStream<never, never>()
    stream.error(new Error('boom'))
    await expect(stream.result()).rejects.toThrow('boom')
  })

  it('consumer waiting on push receives event immediately', async () => {
    const stream = new EventStream<string, void>()
    const received: string[] = []

    // Start consuming before any pushes
    const consuming = (async () => {
      for await (const e of stream) {
        received.push(e)
      }
    })()

    // Allow microtasks to flush so the consumer enters the wait state
    await Promise.resolve()

    stream.push('hello')
    stream.push('world')
    stream.end()

    await consuming
    expect(received).toEqual(['hello', 'world'])
  })

  it('async iteration terminates after end()', async () => {
    const stream = new EventStream<number, null>()
    stream.push(10)
    stream.end(null)

    const events: number[] = []
    for await (const e of stream) {
      events.push(e)
    }
    expect(events).toEqual([10])
  })

  it('async iteration terminates after error()', async () => {
    const stream = new EventStream<number, never>()
    stream.push(99)
    stream.error(new Error('fail'))

    const events: number[] = []
    for await (const e of stream) {
      events.push(e)
    }
    // Events pushed before error() are still delivered
    expect(events).toEqual([99])
    await expect(stream.result()).rejects.toThrow('fail')
  })

  it('delivers events to multiple sequential consumers', async () => {
    const stream = new EventStream<number, string>()
    stream.push(1)
    stream.push(2)
    stream.end('ok')

    const events: number[] = []
    for await (const e of stream) {
      events.push(e)
    }
    expect(events).toEqual([1, 2])
  })
})
