export const DEFAULT_MANAGED_EXECUTION_RECEIPT_STORE_CAPACITY = 1024

// Why: reject new identities at capacity so replay evidence is never evicted.
export class ManagedExecutionReceiptStore<T> {
  private readonly entries = new Map<string, T>()

  constructor(
    private readonly capacity: number = DEFAULT_MANAGED_EXECUTION_RECEIPT_STORE_CAPACITY
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('receipt store capacity must be a positive integer')
    }
  }

  get size(): number {
    return this.entries.size
  }

  get isAtCapacity(): boolean {
    return this.entries.size >= this.capacity
  }

  has(requestId: string): boolean {
    return this.entries.has(requestId)
  }

  get(requestId: string): T | undefined {
    return this.entries.get(requestId)
  }

  set(requestId: string, receipt: T): boolean {
    if (!this.entries.has(requestId) && this.isAtCapacity) {
      return false
    }
    this.entries.set(requestId, receipt)
    return true
  }
}
