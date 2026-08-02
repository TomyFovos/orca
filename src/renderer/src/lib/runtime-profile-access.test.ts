// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _runtimeProfileAccessForTests,
  isManagedRuntimeProfile,
  readRuntimeProfileSync
} from './runtime-profile-access'

function installApi(getRuntimeProfileSync: () => unknown): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { app: { getRuntimeProfileSync } }
  })
}

function removeApi(): void {
  Reflect.deleteProperty(window, 'api')
}

describe('readRuntimeProfileSync', () => {
  beforeEach(() => {
    _runtimeProfileAccessForTests.reset()
  })

  afterEach(() => {
    _runtimeProfileAccessForTests.reset()
    removeApi()
  })

  it('fails closed to managed when the bridge is missing', () => {
    removeApi()
    expect(readRuntimeProfileSync()).toBe('managed')
  })

  it('fails closed to managed when the bridge throws', () => {
    installApi(() => {
      throw new Error('bridge unavailable')
    })
    expect(readRuntimeProfileSync()).toBe('managed')
  })

  it('fails closed to managed when the bridge returns an invalid value', () => {
    installApi(() => 'bogus')
    expect(readRuntimeProfileSync()).toBe('managed')
  })

  it('returns default when the bridge reports default', () => {
    installApi(() => 'default')
    expect(readRuntimeProfileSync()).toBe('default')
  })

  it('returns managed when the bridge reports managed', () => {
    installApi(() => 'managed')
    expect(readRuntimeProfileSync()).toBe('managed')
  })

  it('caches the first resolution and ignores later bridge changes until reset', () => {
    installApi(() => 'default')
    expect(readRuntimeProfileSync()).toBe('default')
    installApi(() => 'managed')
    // Cached: still default even though the bridge now reports managed.
    expect(readRuntimeProfileSync()).toBe('default')
    _runtimeProfileAccessForTests.reset()
    expect(readRuntimeProfileSync()).toBe('managed')
  })

  it('set() forces the cached profile without consulting the bridge', () => {
    removeApi()
    _runtimeProfileAccessForTests.set('default')
    expect(readRuntimeProfileSync()).toBe('default')
  })
})

describe('isManagedRuntimeProfile', () => {
  beforeEach(() => {
    _runtimeProfileAccessForTests.reset()
  })

  afterEach(() => {
    _runtimeProfileAccessForTests.reset()
    removeApi()
  })

  it('reflects an explicit profile argument', () => {
    expect(isManagedRuntimeProfile('managed')).toBe(true)
    expect(isManagedRuntimeProfile('default')).toBe(false)
  })

  it('reads the sync profile when no argument is given', () => {
    installApi(() => 'managed')
    expect(isManagedRuntimeProfile()).toBe(true)
    _runtimeProfileAccessForTests.reset()
    installApi(() => 'default')
    expect(isManagedRuntimeProfile()).toBe(false)
  })
})
