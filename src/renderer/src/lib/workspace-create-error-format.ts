import { translate } from '@/i18n/i18n'
import {
  isManagedWorktreePlacementIpcFailure,
  type ManagedWorktreePlacementIpcFailure
} from '../../../shared/worktree-create-ipc'

export type WorkspaceCreateErrorDisplay = {
  title: string
  message: string
  help?: string
}

const MISSING_BASE_REF_ANCHOR = 'could not resolve a default base ref'

function formatManagedWorktreePlacementError(
  error: ManagedWorktreePlacementIpcFailure
): WorkspaceCreateErrorDisplay {
  switch (error.data.code) {
    case 'unset':
      return {
        title: 'Managed worktree root is not configured',
        message:
          'Managed profile requires a dedicated worktree root before it can create a workspace.',
        help: 'Set ORCA_MANAGED_WORKTREE_ROOT to an absolute, reachable directory, then retry.'
      }
    case 'not_traversable':
      return {
        title: 'Managed worktree root is unreachable',
        message: 'The isolated worker cannot reach the configured managed worktree root.',
        help: 'Choose a root whose ancestors are world-traversable; do not loosen permissions, then retry.'
      }
    default:
      return {
        title: 'Managed worktree placement is unavailable',
        message: 'Orca could not validate a safe managed worktree location.',
        help: 'Review the managed worktree root configuration, then retry.'
      }
  }
}

export function formatWorkspaceCreateError(error: unknown): WorkspaceCreateErrorDisplay {
  if (isManagedWorktreePlacementIpcFailure(error)) {
    return formatManagedWorktreePlacementError(error)
  }
  const message = error instanceof Error ? error.message : 'Failed to create worktree.'

  if (message.toLowerCase().includes(MISSING_BASE_REF_ANCHOR)) {
    return {
      title: translate('auto.lib.workspace.create.error.format.64555d0014', 'No base branch found'),
      message: translate(
        'auto.lib.workspace.create.error.format.37cf0bc991',
        'Orca could not resolve a usable base ref for this workspace.'
      ),
      help: 'Create an initial commit (for example on main), or select an existing branch in Create From, then try again.'
    }
  }

  return {
    title: message,
    message
  }
}

export function getWorkspaceCreateErrorToastMessage(error: WorkspaceCreateErrorDisplay): string {
  return error.help ? error.title : error.message
}
