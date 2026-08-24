import { describe, expect, it } from 'vitest'
import {
  AttemptIdentityRegistry,
  DEFAULT_ATTEMPT_IDENTITY_CAPACITY,
  type AttemptIdentity
} from '../attempt-identity-registry'

function identity(attemptId: string, suffix = 'a'): AttemptIdentity {
  return {
    attemptId,
    backendRef: `orca-attempt-${suffix}`,
    backendSessionId: `orca-session-${suffix}`
  }
}

describe('AttemptIdentityRegistry', () => {
  it('registers an unseen attempt and returns it verbatim', () => {
    const registry = new AttemptIdentityRegistry()

    expect(registry.register(identity('attempt-1'))).toBe(true)
    expect(registry.get('attempt-1')).toEqual(identity('attempt-1'))
    expect(registry.has('attempt-1')).toBe(true)
    expect(registry.size).toBe(1)
  })

  it('refuses to replace an existing binding so a minted identity is never rotated', () => {
    const registry = new AttemptIdentityRegistry()
    registry.register(identity('attempt-1', 'first'))

    expect(registry.register(identity('attempt-1', 'second'))).toBe(false)
    expect(registry.get('attempt-1')).toEqual(identity('attempt-1', 'first'))
    expect(registry.size).toBe(1)
  })

  it('reports an unregistered attempt as absent', () => {
    const registry = new AttemptIdentityRegistry()

    expect(registry.get('missing')).toBeUndefined()
    expect(registry.has('missing')).toBe(false)
  })

  it('rejects new attempts at capacity instead of evicting an existing binding', () => {
    const registry = new AttemptIdentityRegistry(2)
    registry.register(identity('attempt-1'))
    registry.register(identity('attempt-2'))

    expect(registry.isAtCapacity).toBe(true)
    expect(registry.register(identity('attempt-3'))).toBe(false)
    expect(registry.get('attempt-1')).toEqual(identity('attempt-1'))
    expect(registry.get('attempt-2')).toEqual(identity('attempt-2'))
    expect(registry.has('attempt-3')).toBe(false)
    expect(registry.size).toBe(2)
  })

  it('rejects a non-positive or fractional capacity', () => {
    expect(() => new AttemptIdentityRegistry(0)).toThrow(/positive integer/)
    expect(() => new AttemptIdentityRegistry(-1)).toThrow(/positive integer/)
    expect(() => new AttemptIdentityRegistry(1.5)).toThrow(/positive integer/)
  })

  it('defaults to the documented capacity', () => {
    expect(DEFAULT_ATTEMPT_IDENTITY_CAPACITY).toBe(1024)
    expect(new AttemptIdentityRegistry().isAtCapacity).toBe(false)
  })
})
