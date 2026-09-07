import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { assertManagedWorkerGitIsolated } from '../../managed-execution/managed-worker-git-isolation'
import {
  MANAGED_ORCA_RUNTIME_PROFILE,
  type OrcaRuntimeProfile
} from '../../runtime-profile'
import type { RpcContext } from '../core'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

type Runtime = RpcContext['runtime']

export type WorkerStartTarget = {
  requestedWorktree: string
  createsWorktree: boolean
  agent: WorkerStartInput['agent']
  resolvedWorktree: Awaited<ReturnType<Runtime['showManagedWorktree']>> | undefined
}

export type WorkerStartRequestValidation = Pick<
  WorkerStartTarget,
  'requestedWorktree' | 'createsWorktree' | 'agent'
>

export function validateWorkerStartRequest({
  params,
  runtime
}: {
  params: WorkerStartInput
  runtime: Runtime
}): WorkerStartRequestValidation {
  const requestedWorktree = params.worktree ?? 'current'
  const createsWorktree =
    requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
  if (params.terminal && params.agent) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal reuses an existing agent and cannot combine with --agent.'
    )
  }
  if (createsWorktree && params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal cannot combine with new-worktree creation.'
    )
  }
  if (createsWorktree && !params.name) {
    throw new OrchestrationError('invalid_argument', 'New worktrees require --name.')
  }
  if (!createsWorktree && (params.name || params.repo || params.baseBranch || params.setup)) {
    throw new OrchestrationError(
      'invalid_argument',
      'Creation and setup options apply only to new-child or new-top-level worktrees.'
    )
  }
  const agent = params.agent
  if (!params.terminal && (!agent || !isTuiAgent(agent))) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'A configured --agent is required when worker-start creates a terminal.'
    )
  }
  if (agent) {
    runtime.validateOrchestrationAgentLauncher(agent as TuiAgent)
  }
  return { requestedWorktree, createsWorktree, agent }
}

export async function resolveWorkerStartTarget({
  params,
  validation,
  runtime,
  coordinatorWorktree,
  runtimeProfile
}: {
  params: WorkerStartInput
  validation: WorkerStartRequestValidation
  runtime: Runtime
  coordinatorWorktree: Awaited<ReturnType<Runtime['showManagedWorktree']>>
  runtimeProfile: () => OrcaRuntimeProfile
}): Promise<WorkerStartTarget> {
  const { requestedWorktree, createsWorktree, agent } = validation

  if (createsWorktree) {
    await assertOrchestrationWorktreeCreationSupported({
      runtime,
      repoSelector: params.repo ?? coordinatorWorktree.repoId,
      existingPlacement: 'current or an exact existing folder workspace'
    })
  }
  let resolvedWorktree = createsWorktree
    ? undefined
    : requestedWorktree === 'current'
      ? coordinatorWorktree
      : await runtime.showManagedWorktree(requestedWorktree)
  if (runtimeProfile() === MANAGED_ORCA_RUNTIME_PROFILE) {
    if (createsWorktree) {
      const workerRepo = await runtime.showRepo(params.repo ?? coordinatorWorktree.repoId)
      assertManagedWorkerGitIsolated(workerRepo.path, {
        hostUnvalidatable: Boolean(workerRepo.connectionId)
      })
    } else if (resolvedWorktree) {
      const resolvedRepo = await runtime.showRepo(resolvedWorktree.repoId)
      assertManagedWorkerGitIsolated(resolvedWorktree.git.path, {
        hostUnvalidatable: Boolean(resolvedRepo.connectionId)
      })
    }
  }
  return { requestedWorktree, createsWorktree, agent, resolvedWorktree }
}
