import type { z } from 'zod'
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
import type { FederationAttachStartParams } from './orchestration-federation-start-schema'

type FederationAttachParams = z.infer<typeof FederationAttachStartParams>
type Runtime = RpcContext['runtime']

export type FederatedAttachmentValidation = {
  createsWorktree: boolean
  agent: string | undefined
  resolvedWorktree: Awaited<ReturnType<Runtime['showManagedWorktree']>> | undefined
}

export async function validateFederatedAttachment({
  params,
  runtime,
  orchestrationMutation,
  runtimeProfile
}: {
  params: FederationAttachParams
  runtime: Runtime
  orchestrationMutation: RpcContext['orchestrationMutation']
  runtimeProfile: () => OrcaRuntimeProfile
}): Promise<FederatedAttachmentValidation> {
  if (!orchestrationMutation) {
    throw new OrchestrationError(
      'invalid_argument',
      'Federated worker attachment requires a durable retry request.'
    )
  }
  if (params.worktree === 'current' || params.worktree === 'new-child') {
    throw new OrchestrationError(
      'invalid_argument',
      'A remote worker requires an exact existing worktree or new-top-level.'
    )
  }
  const createsWorktree = params.worktree === 'new-top-level'
  if (createsWorktree && (!params.name || !params.repo)) {
    throw new OrchestrationError(
      'invalid_argument',
      'A remote new-top-level worktree requires --name and an explicit --repo.'
    )
  }
  if (createsWorktree && params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal cannot combine with remote new-worktree creation.'
    )
  }
  if (
    !createsWorktree &&
    (params.name || params.repo || params.baseBranch || params.setup || params.setupSource)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'Creation and setup options apply only to remote new-top-level worktrees.'
    )
  }
  if (params.terminal && params.agent) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal reuses an existing agent and cannot combine with --agent.'
    )
  }
  const agent = params.agent
  if (!params.terminal && (!agent || !isTuiAgent(agent))) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'A configured --agent is required when federated worker-start creates a terminal.'
    )
  }
  if (agent) {
    runtime.validateOrchestrationAgentLauncher(agent as TuiAgent)
  }
  let resolvedWorktree: FederatedAttachmentValidation['resolvedWorktree']
  if (runtimeProfile() === MANAGED_ORCA_RUNTIME_PROFILE) {
    // Why: a receiver cannot validate Git metadata on a remote connection; reject before
    // accepting the attachment or creating any worktree/terminal side effect.
    if (!createsWorktree) {
      resolvedWorktree = await runtime.showManagedWorktree(params.worktree).catch(() => {
        throw new OrchestrationError(
          'worktree_not_found_on_server',
          `Worktree ${params.worktree} was not found on the selected worker server.`
        )
      })
    }
    const repo = await runtime.showRepo(resolvedWorktree?.repoId ?? (params.repo as string))
    assertManagedWorkerGitIsolated(
      resolvedWorktree?.git?.path ?? repo.path,
      repo.connectionId ? { hostUnvalidatable: true } : undefined
    )
  }
  if (createsWorktree) {
    await assertOrchestrationWorktreeCreationSupported({
      runtime,
      repoSelector: params.repo as string,
      existingPlacement: 'an exact existing folder workspace'
    })
  }
  return { createsWorktree, agent, resolvedWorktree }
}
