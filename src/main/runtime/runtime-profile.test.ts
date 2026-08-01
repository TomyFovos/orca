import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ORCA_RUNTIME_PROFILE,
  InvalidOrcaRuntimeProfileError,
  MANAGED_ORCA_RUNTIME_PROFILE,
  ORCA_RUNTIME_PROFILE_ENV,
  resolveOrcaRuntimeProfile
} from './runtime-profile'

describe('resolveOrcaRuntimeProfile', () => {
  it('uses default only when the environment variable is absent', () => {
    expect(resolveOrcaRuntimeProfile({})).toBe(DEFAULT_ORCA_RUNTIME_PROFILE)
  })

  it.each([DEFAULT_ORCA_RUNTIME_PROFILE, MANAGED_ORCA_RUNTIME_PROFILE])(
    'accepts the explicit %s profile',
    (profile) => {
      expect(resolveOrcaRuntimeProfile({ [ORCA_RUNTIME_PROFILE_ENV]: profile })).toBe(profile)
    }
  )

  it.each(['', 'Default', 'managed ', 'external-control-plane'])(
    'rejects the supplied invalid profile %j instead of falling back to default',
    (profile) => {
      expect(() => resolveOrcaRuntimeProfile({ [ORCA_RUNTIME_PROFILE_ENV]: profile })).toThrow(
        InvalidOrcaRuntimeProfileError
      )
    }
  )
})
