import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from './orchestration'

const ambientOrchestrationEnv = [
  'ORCA_DEV_CLI_INVOCATION',
  'ORCA_USER_DATA_PATH',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_PANE_KEY',
  'ORCA_APP_EXECUTABLE',
  'ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT'
] as const

beforeEach(() => {
  for (const name of ambientOrchestrationEnv) {
    vi.stubEnv(name, undefined)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('orchestration CLI migration recovery', () => {
  it('forwards legacy worker_done without inventing a completion outcome', async () => {
    process.env.ORCA_PANE_KEY = 'tab-worker:leaf-worker'
    const call = vi.fn().mockResolvedValue({ result: { message: { id: 'msg_done' } } })

    await ORCHESTRATION_HANDLERS['orchestration send']({
      flags: new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['subject', 'Done'],
        ['type', 'worker_done']
      ]),
      client: { call },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(call).toHaveBeenCalledWith('orchestration.send', {
      from: 'term_worker',
      to: undefined,
      run: undefined,
      subject: 'Done',
      body: undefined,
      type: 'worker_done',
      priority: undefined,
      threadId: undefined,
      payload: undefined,
      senderPaneKey: 'tab-worker:leaf-worker',
      devMode: false
    })
  })
})
