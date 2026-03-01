/**
 * Generic push/iterate event stream.
 *
 * Producer calls push() to emit events and end(result) or error(err) to finish.
 * Consumer iterates with `for await (const event of stream)` and awaits stream.result().
 */
export class EventStream<T, R> {
  private readonly queue:   T[]   = []
  private readonly waiters: Array<(v: T | null) => void> = []
  private done = false
  private readonly resultP: Promise<R>
  private resolveResult!: (r: R) => void
  private rejectResult!:  (e: Error) => void

  constructor() {
    this.resultP = new Promise<R>((res, rej) => {
      this.resolveResult = res
      this.rejectResult  = rej
    })
  }

  /** Emit one event to the next waiting consumer, or buffer it if none is waiting. */
  push(event: T): void {
    const waiter = this.waiters.shift()
    if (waiter) { waiter(event); return }
    this.queue.push(event)
  }

  /** Signal successful completion. Resolves the result promise and unblocks all consumers. */
  end(result: R): void {
    this.done = true
    this.resolveResult(result)
    this.waiters.splice(0).forEach((w) => w(null))
  }

  /** Signal an error. Rejects the result promise and unblocks all consumers. */
  error(err: Error): void {
    this.done = true
    this.rejectResult(err)
    this.waiters.splice(0).forEach((w) => w(null))
  }

  /** Await the final result value (resolves after end(), rejects after error()). */
  result(): Promise<R> { return this.resultP }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.queue.length > 0) { yield this.queue.shift()!; continue }
      if (this.done) return
      const item = await new Promise<T | null>((res) => this.waiters.push(res))
      if (item === null) return
      yield item
    }
  }
}
