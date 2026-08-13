import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MANAGED_ORCA_RUNTIME_PROFILE,
  ORCA_RUNTIME_PROFILE_ENV,
  setProcessRuntimeProfile
} from '../runtime-profile'
import {
  ManagedExecutionAuthorizationRequiredError,
  assertManagedExecutionAuthorized,
  filterManagedExecutionSkillDelivery,
  mintManagedExecutionAuthorization,
  propagateManagedRuntimeProfile
} from './authorization'

describe('managed execution authorization boundary', () => {
  afterEach(() => {
    setProcessRuntimeProfile('default')
  })

  it.each([
    ['target CLI startup', 'target-cli-startup'],
    ['managed worker startup', 'managed-worker-startup'],
    ['automation worker startup', 'automation-worker-startup'],
    ['Claude Agent Teams startup', 'claude-agent-teams'],
    ['managed worktree removal', 'managed-worktree-removal'],
    ['managed Task creation', 'task-dispatch-mutation']
  ])('records the managed %s rejection reason', (operation, field) => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => assertManagedExecutionAuthorized(operation, {})).toThrow(
      ManagedExecutionAuthorizationRequiredError
    )
    expect(error).toHaveBeenCalledWith(
      `[managed-execution] Request rejected: operation=${field} layer=authorization field=${field} rule=external-control-plane-authorization`
    )
    error.mockRestore()
  })

  it('accepts a capability minted by the module-private issuer path', () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    const authorization = mintManagedExecutionAuthorization()

    expect(() => assertManagedExecutionAuthorized('worker startup', authorization)).not.toThrow()
  })

  it('keeps the default profile authorization-free', () => {
    setProcessRuntimeProfile('default')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => assertManagedExecutionAuthorized('worker startup', {})).not.toThrow()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
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
