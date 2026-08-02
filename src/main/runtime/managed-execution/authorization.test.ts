import { afterEach, describe, expect, it } from 'vitest'
import {
  MANAGED_ORCA_RUNTIME_PROFILE,
  ORCA_RUNTIME_PROFILE_ENV,
  setProcessRuntimeProfile
} from '../runtime-profile'
import {
  ManagedExecutionAuthorizationRequiredError,
  assertManagedExecutionAuthorized,
  filterManagedExecutionSkillDelivery,
  propagateManagedRuntimeProfile
} from './authorization'

describe('managed execution authorization boundary', () => {
  afterEach(() => {
    setProcessRuntimeProfile('default')
  })

  it('rejects an RPC-reconstructable authorization value in managed mode', () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)

    expect(() => assertManagedExecutionAuthorized('worker startup', {})).toThrow(
      ManagedExecutionAuthorizationRequiredError
    )
  })

  it('keeps the default profile authorization-free', () => {
    setProcessRuntimeProfile('default')

    expect(() => assertManagedExecutionAuthorized('worker startup', {})).not.toThrow()
  })

  it('only injects the managed profile into child environments', () => {
    const environment = { EXISTING: 'value' }

    expect(propagateManagedRuntimeProfile(environment, 'default')).toBe(environment)
    expect(propagateManagedRuntimeProfile(environment, MANAGED_ORCA_RUNTIME_PROFILE)).toEqual({
      EXISTING: 'value',
      [ORCA_RUNTIME_PROFILE_ENV]: MANAGED_ORCA_RUNTIME_PROFILE
    })
  })

  it('skips only orchestration skill delivery in managed mode', () => {
    expect(
      filterManagedExecutionSkillDelivery(
        ['orchestration', 'orca-cli'],
        MANAGED_ORCA_RUNTIME_PROFILE
      )
    ).toEqual({ allowedNames: ['orca-cli'], skippedNames: ['orchestration'] })
    expect(filterManagedExecutionSkillDelivery(['orca-cli'], 'default')).toEqual({
      allowedNames: ['orca-cli'],
      skippedNames: []
    })
  })
})
