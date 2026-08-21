import type { CreateWorktreeResult } from './types'

export const MANAGED_WORKTREE_PLACEMENT_IPC_FAILURE_KIND =
  'managed_worktree_placement_rejected' as const

export type ManagedWorktreePlacementIpcFailure = Readonly<{
  kind: typeof MANAGED_WORKTREE_PLACEMENT_IPC_FAILURE_KIND
  code: 'managed_worktree_placement_unavailable'
  data: Readonly<{
    code: string
    field: string
    rule: string
    detail: string
  }>
  message: string
}>

export type WorktreeCreateIpcResult = CreateWorktreeResult | ManagedWorktreePlacementIpcFailure

export function isManagedWorktreePlacementIpcFailure(
  value: unknown
): value is ManagedWorktreePlacementIpcFailure {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as {
    kind?: unknown
    code?: unknown
    data?: unknown
    message?: unknown
  }
  if (
    candidate.kind !== MANAGED_WORKTREE_PLACEMENT_IPC_FAILURE_KIND ||
    candidate.code !== 'managed_worktree_placement_unavailable' ||
    typeof candidate.message !== 'string' ||
    typeof candidate.data !== 'object' ||
    candidate.data === null
  ) {
    return false
  }
  const data = candidate.data as Record<string, unknown>
  return (
    typeof data.code === 'string' &&
    typeof data.field === 'string' &&
    typeof data.rule === 'string' &&
    typeof data.detail === 'string'
  )
}
