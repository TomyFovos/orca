import os from 'node:os'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: spawnMock }))

import { runManagedWorkerForProtectedEffect } from './worker-effect'

describe('managed protected effect worker launcher', () => {
  const previousCliPath = process.env.ORCA_AI_DE_CLI_PATH

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.ORCA_AI_DE_CLI_PATH
    process.env.ORCA_AI_DE_CLI_PATH = '/opt/ai-de/cli/aide'
  })

  afterEach(() => {
    if (previousCliPath === undefined) {
      delete process.env.ORCA_AI_DE_CLI_PATH
    } else {
      process.env.ORCA_AI_DE_CLI_PATH = previousCliPath
    }
  })

  it('invokes aide worker and records the structured fail-closed refusal', () => {
    spawnMock.mockReturnValue({
      status: 1,
      stdout: `${JSON.stringify({
        status: 'REJECTED',
        execution_allowed: false,
        refusal: {
          layer: 'private-store',
          field: 'packet_ref',
          rule: 'broker-must-be-configured',
          reason_code: 'PACKET_STORE_UNSAFE'
        },
        spawn_result: null
      })}\n`,
      stderr: ''
    })
    const logger = vi.fn()

    const result = runManagedWorkerForProtectedEffect(
      { packet_digest: `sha256:${'a'.repeat(64)}` },
      { logger }
    )

    expect(result.execution_allowed).toBe(false)
    expect(result.refusal).toEqual({
      layer: 'private-store',
      field: 'packet_ref',
      rule: 'broker-must-be-configured',
      reason_code: 'PACKET_STORE_UNSAFE'
    })
    expect(spawnMock).toHaveBeenCalledWith(
      '/opt/ai-de/cli/aide',
      ['worker', '--packet-ref', `sha256:${'a'.repeat(64)}`],
      expect.objectContaining({ cwd: os.tmpdir(), env: expect.any(Object) })
    )
    const loggedRefusal = JSON.parse(logger.mock.calls[0][1] as string) as Record<string, unknown>
    expect(loggedRefusal).toMatchObject({
      layer: 'private-store',
      field: 'packet_ref',
      rule: 'broker-must-be-configured',
      reason_code: 'PACKET_STORE_UNSAFE'
    })
  })

  it('fails closed when the worker output is not valid JSON', () => {
    spawnMock.mockReturnValue({ status: 1, stdout: 'not-json\n', stderr: 'worker failed' })

    const result = runManagedWorkerForProtectedEffect(
      { packet_digest: `sha256:${'b'.repeat(64)}` },
      { logger: vi.fn() }
    )

    expect(result.execution_allowed).toBe(false)
    expect(result.refusal).toMatchObject({
      layer: 'trusted-worker-launcher',
      field: 'pipeline',
      rule: 'execution_allowed_true'
    })
  })
})
