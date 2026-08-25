import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createOrchestrationFederationAttachMethods } from './orchestration-federation'

describe('orchestration federated folder placement', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('rejects a new folder workspace before accepting the remote attachment', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'folder-repo',
      kind: 'folder'
    } as never)
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }

    await expect(
      method.handler(
        method.params!.parse({
          dispatchId: 'ctx_folder',
          taskId: 'task_folder',
          taskSpec: 'work in folder',
          protocolVersion: 1,
          worktree: 'new-top-level',
          repo: 'folder-repo',
          name: 'folder-worker',
          agent: 'codex'
        }),
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'home_peer',
            requestId: 'request_folder',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'folder_payload'
          }
        }
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        'Folder projects cannot create orchestration worktrees; use an exact existing folder workspace.'
    })
    expect(db.getRemoteDispatchAttachment('ctx_folder')).toBeUndefined()
    expect(db.getMutationReceipt('home_peer', 'request_folder')).toBeUndefined()
  })

  it('rejects managed new-top-level before creating a remote attachment or worktree', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    const createWorktree = vi.spyOn(runtime, 'createManagedWorktree')
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'remote-repo',
      kind: 'git',
      path: '/remote/worktree',
      connectionId: 'ssh-remote'
    } as never)
    const method = createOrchestrationFederationAttachMethods(() => 'managed').find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )!

    await expect(
      method.handler(
        method.params!.parse({
          dispatchId: 'ctx_managed_new',
          taskId: 'task_managed_new',
          taskSpec: 'managed remote work',
          protocolVersion: 1,
          worktree: 'new-top-level',
          repo: 'remote-repo',
          name: 'remote-worker',
          agent: 'codex'
        }),
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'home_peer',
            requestId: 'request_managed_new',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'managed_new_payload'
          }
        }
      )
    ).rejects.toMatchObject({
      code: 'managed_worker_git_isolation_required',
      data: { rule: 'local-posix-host-only' }
    })
    expect(db.getRemoteDispatchAttachment('ctx_managed_new')).toBeUndefined()
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('rejects managed existing worktree before attachment or terminal creation', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'remote-worktree',
      repoId: 'remote-repo',
      git: { path: '/remote/worktree' }
    } as never)
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'remote-repo',
      kind: 'git',
      path: '/remote/worktree',
      connectionId: 'ssh-remote'
    } as never)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    const method = createOrchestrationFederationAttachMethods(() => 'managed').find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )!

    await expect(
      method.handler(
        method.params!.parse({
          dispatchId: 'ctx_managed_existing',
          taskId: 'task_managed_existing',
          taskSpec: 'managed existing work',
          protocolVersion: 1,
          worktree: 'id:remote-worktree',
          agent: 'codex'
        }),
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'home_peer',
            requestId: 'request_managed_existing',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'managed_existing_payload'
          }
        }
      )
    ).rejects.toMatchObject({
      code: 'managed_worker_git_isolation_required',
      data: { rule: 'local-posix-host-only' }
    })
    expect(db.getRemoteDispatchAttachment('ctx_managed_existing')).toBeUndefined()
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('keeps the default profile federation receiver successful for a local worktree', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'local-worktree',
      repoId: 'local-repo',
      git: { path: '/local/worktree' }
    } as never)
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'local-repo',
      kind: 'git',
      path: '/local/worktree',
      connectionId: null
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({ handle: 'term_local_worker' } as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_local_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_local:leaf_local')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('local_runtime:pty:1')
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_local_worker',
      accepted: true,
      bytesWritten: 1
    })
    const method = createOrchestrationFederationAttachMethods(() => 'default').find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )!

    await expect(
      method.handler(
        method.params!.parse({
          dispatchId: 'ctx_default_existing',
          taskId: 'task_default_existing',
          taskSpec: 'default local work',
          protocolVersion: 1,
          worktree: 'id:local-worktree',
          agent: 'codex'
        }),
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'home_peer',
            requestId: 'request_default_existing',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'default_existing_payload'
          }
        }
      )
    ).resolves.toMatchObject({
      dispatchId: 'ctx_default_existing',
      state: 'ready',
      worktreeId: 'local-worktree',
      terminalHandle: 'term_local_worker'
    })
    expect(db.getRemoteDispatchAttachment('ctx_default_existing')).toMatchObject({ state: 'ready' })
  })
})
