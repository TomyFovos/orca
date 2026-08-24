import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MANAGED_ORCA_RUNTIME_PROFILE,
  ORCA_RUNTIME_PROFILE_ENV,
  setProcessRuntimeProfile
} from '../runtime-profile'
import {
  assertExternalManagedExecutionAuthorized,
  ManagedExecutionAuthorizationRequiredError,
  assertManagedExecutionAuthorized,
  filterManagedExecutionSkillDelivery,
  MANAGED_EXECUTION_AUTHORIZATION_OPERATIONS,
  mintManagedExecutionAuthorization,
  propagateManagedRuntimeProfile
} from './authorization'

describe('managed execution authorization boundary', () => {
  afterEach(() => {
    setProcessRuntimeProfile('default')
  })

  it.each([
    [MANAGED_EXECUTION_AUTHORIZATION_OPERATIONS.targetCliStartup, 'target-cli-startup'],
    [MANAGED_EXECUTION_AUTHORIZATION_OPERATIONS.managedWorkerStartup, 'managed-worker-startup'],
    [
      MANAGED_EXECUTION_AUTHORIZATION_OPERATIONS.automationWorkerStartup,
      'automation-worker-startup'
    ],
    [MANAGED_EXECUTION_AUTHORIZATION_OPERATIONS.claudeAgentTeamsStartup, 'claude-agent-teams'],
    [MANAGED_EXECUTION_AUTHORIZATION_OPERATIONS.managedWorktreeRemoval, 'managed-worktree-removal'],
    [MANAGED_EXECUTION_AUTHORIZATION_OPERATIONS.managedTaskCreation, 'task-dispatch-mutation']
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

  it('records unrecognized external operations without exposing their value', () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() =>
      assertExternalManagedExecutionAuthorized('externally-supplied-operation', {})
    ).toThrow(ManagedExecutionAuthorizationRequiredError)
    expect(error).toHaveBeenCalledWith(
      '[managed-execution] Request rejected: operation=unrecognized-operation layer=authorization field=operation rule=external-control-plane-authorization'
    )
    error.mockRestore()
  })

  it('accepts a capability minted by the module-private issuer path', () => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    const authorization = mintManagedExecutionAuthorization()

    expect(() =>
      assertExternalManagedExecutionAuthorized('worker startup', authorization)
    ).not.toThrow()
  })

  it('keeps the default profile authorization-free', () => {
    setProcessRuntimeProfile('default')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => assertExternalManagedExecutionAuthorized('worker startup', {})).not.toThrow()
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
