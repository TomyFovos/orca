import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { defineMethod, type RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { ALL_RPC_METHODS } from './methods'
import {
  MANAGED_RUNTIME_EXCLUDED_METHOD_PREFIXES,
  selectRpcMethodsForRuntimeProfile
} from './runtime-profile-method-registry'

const SAFE_METHOD = defineMethod({
  name: 'terminal.profileProbe',
  params: z.object({}),
  handler: () => ({ source: 'terminal' })
})

const ORCHESTRATION_READ_METHOD = defineMethod({
  name: 'orchestration.taskList',
  params: z.object({}),
  handler: () => ({ source: 'orchestration' })
})

const PROFILE_METHODS = [SAFE_METHOD, ORCHESTRATION_READ_METHOD] as const

function request(method: string): RpcRequest {
  return {
    id: `rpc_${method}`,
    authToken: 'profile-test-token',
    method,
    params: {}
  }
}

describe('runtime profile RPC boundary', () => {
  it('retains the supplied method registry exactly in default mode', async () => {
    expect(selectRpcMethodsForRuntimeProfile('default', PROFILE_METHODS)).toBe(PROFILE_METHODS)

    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      profile: 'default',
      methods: PROFILE_METHODS
    })

    await expect(dispatcher.dispatch(request(SAFE_METHOD.name))).resolves.toMatchObject({
      ok: true,
      result: { source: 'terminal' }
    })
  })

  it('removes only real registered method names that match the managed exclusion policy', () => {
    const allMethodNames = ALL_RPC_METHODS.map((method) => method.name)
    const excludedMethodNames = allMethodNames.filter((methodName) =>
      MANAGED_RUNTIME_EXCLUDED_METHOD_PREFIXES.some((prefix) => methodName.startsWith(prefix))
    )
    const managedMethodNames = selectRpcMethodsForRuntimeProfile('managed', ALL_RPC_METHODS).map(
      (method) => method.name
    )

    expect(excludedMethodNames).not.toHaveLength(0)
    expect(managedMethodNames).toEqual(
      allMethodNames.filter((methodName) => !excludedMethodNames.includes(methodName))
    )
    expect(managedMethodNames).not.toEqual(expect.arrayContaining(excludedMethodNames))
  })

  it('uses the injected managed profile to reject coordinator RPC while keeping terminal RPC available', async () => {
    expect(selectRpcMethodsForRuntimeProfile('managed', PROFILE_METHODS)).toEqual([SAFE_METHOD])

    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      profile: 'managed',
      methods: PROFILE_METHODS
    })

    await expect(dispatcher.dispatch(request(SAFE_METHOD.name))).resolves.toMatchObject({
      ok: true,
      result: { source: 'terminal' }
    })
    await expect(
      dispatcher.dispatch(request(ORCHESTRATION_READ_METHOD.name))
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'method_not_found' }
    })
  })
})
