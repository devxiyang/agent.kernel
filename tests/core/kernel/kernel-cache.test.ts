import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { KernelCache } from '../../../src/core/kernel/kernel-cache.js'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

function makeTmpDir(): string {
  const dir = mkdtempSync(tmpdir() + '/kernel-cache-test-')
  tmpDirs.push(dir)
  return dir
}

describe('KernelCache', () => {
  describe('cache hit / miss', () => {
    it('returns a kernel on first get (cache miss)', () => {
      const cache = new KernelCache({ dir: makeTmpDir() })
      const kernel = cache.get('s1')
      expect(kernel).toBeDefined()
      expect(cache.size).toBe(1)
    })

    it('returns the same kernel instance on subsequent gets (cache hit)', () => {
      const cache = new KernelCache({ dir: makeTmpDir() })
      const k1 = cache.get('s1')
      const k2 = cache.get('s1')
      expect(k1).toBe(k2)
    })

    it('returns different instances for different sessionIds', () => {
      const dir   = makeTmpDir()
      const cache = new KernelCache({ dir })
      const k1 = cache.get('s1')
      const k2 = cache.get('s2')
      expect(k1).not.toBe(k2)
      expect(cache.size).toBe(2)
    })
  })

  describe('LRU eviction', () => {
    it('evicts the least recently used entry when maxSize is exceeded', () => {
      const cache = new KernelCache({ dir: makeTmpDir(), maxSize: 2 })
      const k1 = cache.get('s1')
      const k2 = cache.get('s2')  // cache: [s1, s2]
      cache.get('s3')              // exceeds maxSize → evicts s1; cache: [s2, s3]

      expect(cache.size).toBe(2)
      // s2 is still cached — check before accessing s1 (which would evict again)
      expect(cache.get('s2')).toBe(k2)
      // s1 was evicted — new instance created
      expect(cache.get('s1')).not.toBe(k1)
    })

    it('promotes accessed entries to most-recently-used', () => {
      const cache = new KernelCache({ dir: makeTmpDir(), maxSize: 2 })
      cache.get('s1')   // cache: [s1]
      const k2 = cache.get('s2')  // cache: [s1, s2]
      cache.get('s1')   // access s1 → promote; cache: [s2, s1]
      cache.get('s3')   // evicts s2 (LRU); cache: [s1, s3]

      expect(cache.size).toBe(2)
      expect(cache.get('s2')).not.toBe(k2)  // s2 was evicted
    })
  })

  describe('TTL eviction', () => {
    it('serves cached kernel within TTL', () => {
      let now = 1000
      const perf  = { now: () => now }
      const cache = new KernelCache({ dir: makeTmpDir(), ttl: 1000, perf })
      const k1 = cache.get('s1')
      now += 999
      expect(cache.get('s1')).toBe(k1)
    })

    it('evicts and recreates kernel after TTL expires', () => {
      let now = 1000
      const perf  = { now: () => now }
      const cache = new KernelCache({ dir: makeTmpDir(), ttl: 1000, perf })
      const k1 = cache.get('s1')
      now += 1001
      expect(cache.get('s1')).not.toBe(k1)
    })

    it('TTL resets on each access', () => {
      let now = 1000
      const perf  = { now: () => now }
      const cache = new KernelCache({ dir: makeTmpDir(), ttl: 1000, perf })
      const k1 = cache.get('s1')
      now += 800
      cache.get('s1')  // access resets TTL
      now += 800       // 800ms after reset — still within TTL
      expect(cache.get('s1')).toBe(k1)
    })
  })

  describe('evict / clear', () => {
    it('evict removes a specific session', () => {
      const cache = new KernelCache({ dir: makeTmpDir() })
      const k1 = cache.get('s1')
      cache.get('s2')
      cache.evict('s1')
      expect(cache.size).toBe(1)
      expect(cache.get('s1')).not.toBe(k1)  // recreated
    })

    it('evict is a no-op for unknown sessionId', () => {
      const cache = new KernelCache({ dir: makeTmpDir() })
      cache.get('s1')
      expect(() => cache.evict('unknown')).not.toThrow()
      expect(cache.size).toBe(1)
    })

    it('clear removes all entries', () => {
      const cache = new KernelCache({ dir: makeTmpDir() })
      cache.get('s1')
      cache.get('s2')
      cache.clear()
      expect(cache.size).toBe(0)
    })
  })

  describe('defaults', () => {
    it('accepts maxSize and ttl defaults without throwing', () => {
      const cache = new KernelCache({ dir: makeTmpDir() })
      expect(() => cache.get('s1')).not.toThrow()
    })
  })
})
