import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { defineMethod, type RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { selectRpcMethodsForRuntimeProfile } from './runtime-profile-method-registry'

const SAFE_METHOD = defineMethod({
  name: 'terminal.profileProbe',
  params: z.object({}),
  handler: () => ({ source: 'terminal' })
})

const ORCHESTRATION_METHOD = defineMethod({
  name: 'orchestration.profileProbe',
  params: z.object({}),
  handler: (_params, context) => ({
    source: 'orchestration',
    capability: context.orchestrationCapability
  })
})

const AGENT_TEAMS_METHOD = defineMethod({
  name: 'agentTeams.prepareLaunch',
  params: z.object({}),
  handler: () => ({ source: 'agent-teams' })
})

const PROFILE_METHODS = [SAFE_METHOD, ORCHESTRATION_METHOD, AGENT_TEAMS_METHOD] as const

function request(method: string): RpcRequest {
  return {
    id: `rpc_${method}`,
    authToken: 'profile-test-token',
    method,
    params: {}
  }
}

describe('runtime profile RPC boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('retains the existing method registry exactly in default mode', async () => {
    vi.stubEnv('ORCA_RUNTIME_PROFILE', 'default')
    expect(selectRpcMethodsForRuntimeProfile('default', PROFILE_METHODS)).toBe(PROFILE_METHODS)

    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      methods: PROFILE_METHODS
    })

    await expect(
      dispatcher.dispatch({
        ...request(ORCHESTRATION_METHOD.name),
        orchestrationCapability: 'legacy'
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { source: 'orchestration', capability: 'legacy' }
    })
  })

  it('rejects coordinator and agent-teams methods in managed mode while keeping terminal RPC available', async () => {
    vi.stubEnv('ORCA_RUNTIME_PROFILE', 'managed')
    expect(selectRpcMethodsForRuntimeProfile('managed', PROFILE_METHODS)).toEqual([SAFE_METHOD])

    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      methods: PROFILE_METHODS
    })

    await expect(dispatcher.dispatch(request(SAFE_METHOD.name))).resolves.toMatchObject({
      ok: true,
      result: { source: 'terminal' }
    })
    await expect(dispatcher.dispatch(request(ORCHESTRATION_METHOD.name))).resolves.toMatchObject({
      ok: false,
      error: { code: 'method_not_found' }
    })
    await expect(dispatcher.dispatch(request(AGENT_TEAMS_METHOD.name))).resolves.toMatchObject({
      ok: false,
      error: { code: 'method_not_found' }
    })
  })

  it('refuses to initialize a dispatcher for an invalid supplied profile', () => {
    vi.stubEnv('ORCA_RUNTIME_PROFILE', 'managed-preview')

    expect(
      () => new RpcDispatcher({ runtime: new OrcaRuntimeService(), methods: PROFILE_METHODS })
    ).toThrow(/Unsupported ORCA_RUNTIME_PROFILE value/)
  })
})
