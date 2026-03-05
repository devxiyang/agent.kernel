import { LRUCache } from 'lru-cache'
import { createKernel } from './kernel'
import type { AgentKernel, KernelOptions } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KernelCacheOptions {
  /** Base directory for thread persistence (passed to createKernel). */
  dir: string
  /** Maximum number of kernels to keep in memory. LRU eviction. Default: 50 */
  maxSize?: number
  /** Milliseconds of inactivity before a kernel is evicted. Default: 30 minutes */
  ttl?: number
  /** Injectable time source for testing. Defaults to performance or Date. */
  perf?: { now(): number }
}

// ─── KernelCache ──────────────────────────────────────────────────────────────

/**
 * In-memory LRU cache of AgentKernel instances keyed by threadId.
 *
 * Kernels are expensive to recreate because loadFromFile replays kernel.jsonl
 * on every cold start. KernelCache keeps hot threads in memory and evicts
 * them by LRU order or TTL, falling back to file-based restore on cache miss.
 */
export class KernelCache {
  private readonly _dir:   string
  private readonly _cache: LRUCache<string, AgentKernel>

  constructor(options: KernelCacheOptions) {
    this._dir   = options.dir
    this._cache = new LRUCache<string, AgentKernel>({
      max:  options.maxSize ?? 50,
      ttl:  options.ttl     ?? 30 * 60 * 1000,
      ...(options.perf && { perf: options.perf }),
    })
  }

  /**
   * Return the cached kernel for threadId, or create one from disk.
   * Updates LRU order and TTL on every call.
   */
  get(threadId: string, meta?: KernelOptions['meta']): AgentKernel {
    const cached = this._cache.get(threadId)
    if (cached) return cached

    const kernel = createKernel({ dir: this._dir, threadId, meta })
    this._cache.set(threadId, kernel)
    return kernel
  }

  /** Remove a specific thread from the cache. */
  evict(threadId: string): void {
    this._cache.delete(threadId)
  }

  /** Remove all cached kernels. */
  clear(): void {
    this._cache.clear()
  }

  /** Number of kernels currently in cache. */
  get size(): number {
    return this._cache.size
  }
}
