import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CliCommandModule from '../shared/node-cli-command-resolution'

const { resolveCliCommandMock, spawnMock } = vi.hoisted(() => ({
  resolveCliCommandMock: vi.fn(() => 'npx'),
  spawnMock: vi.fn()
}))

vi.mock('../shared/node-cli-command-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof CliCommandModule>()),
  resolveCliCommand: resolveCliCommandMock
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

vi.mock('./bundled-skill-guides.js', () => ({
  BUNDLED_SKILL_GUIDES: [
    { name: 'alpha', description: '', markdown: '', fullMarkdown: '', aliases: [] },
    { name: 'gamma', description: '', markdown: '', fullMarkdown: '', aliases: [] },
    {
      name: 'orchestration',
      description: '',
      markdown: '',
      fullMarkdown: '',
      aliases: []
    },
    { name: 'zeta', description: '', markdown: '', fullMarkdown: '', aliases: [] }
  ]
}))

vi.mock('./runtime-client', async () => {
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('./runtime/types.js')
  return {
    RuntimeClient: class {},
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: vi.fn(),
    getDefaultUserDataPath: vi.fn(() => '/tmp/orca-user-data')
  }
})

import { main } from './index'

const managedSkipMessage =
  'Skipped orchestration skill delivery in managed execution: it requires external control-plane authorization.\n'

describe('orca skills CLI managed profile', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubEnv('ORCA_RUNTIME_PROFILE', 'managed')
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockReturnValue('npx')
    spawnMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('skips orchestration but updates remaining explicitly requested skills', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(
      ['skills', 'update', '--skill', 'orchestration', '--skill', 'alpha'],
      '/tmp/repo'
    )
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['--yes', 'skills', 'update', 'alpha', '--global', '-y'],
      expect.objectContaining({ stdio: 'inherit' })
    )
    expect(stderrSpy).toHaveBeenCalledWith(managedSkipMessage)
  })

  it('does not spawn when orchestration is the only requested skill', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await main(['skills', 'update', '--skill', 'orchestration'], '/tmp/repo')

    expect(spawnMock).not.toHaveBeenCalled()
    expect(stderrSpy).toHaveBeenCalledWith(managedSkipMessage)
  })

  it('filters only orchestration from a managed --all update', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'update', '--all'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['--yes', 'skills', 'update', 'alpha', 'gamma', 'zeta', '--global', '-y'],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })
})

function createFakeChild(): EventEmitter {
  return new EventEmitter()
}
