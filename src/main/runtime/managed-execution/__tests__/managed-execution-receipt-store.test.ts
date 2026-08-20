import { describe, expect, test } from 'vitest'
import { ManagedExecutionReceiptStore } from '../managed-execution-receipt-store'

describe('ManagedExecutionReceiptStore', () => {
  test('keeps the entry count bounded and retains every admitted request identity', () => {
    const store = new ManagedExecutionReceiptStore<string>(2)

    expect(store.set('request-one', 'receipt-one')).toBe(true)
    expect(store.set('request-two', 'receipt-two')).toBe(true)
    expect(store.set('request-three', 'receipt-three')).toBe(false)

    expect(store.size).toBe(2)
    expect(store.isAtCapacity).toBe(true)
    expect(store.has('request-one')).toBe(true)
    expect(store.has('request-two')).toBe(true)
    expect(store.has('request-three')).toBe(false)
  })

  test('allows an existing request to refresh its stored receipt at capacity', () => {
    const store = new ManagedExecutionReceiptStore<string>(1)

    expect(store.set('request-one', 'original')).toBe(true)
    expect(store.set('request-one', 'refreshed')).toBe(true)

    expect(store.size).toBe(1)
    expect(store.get('request-one')).toBe('refreshed')
  })

  test.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    'rejects an invalid capacity %s',
    (capacity) => {
      expect(() => new ManagedExecutionReceiptStore(capacity)).toThrow(
        'receipt store capacity must be a positive integer'
      )
    }
  )
})
