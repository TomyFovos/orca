import {
  FEATURE_WALL_TILES,
  isFeatureWallMediaTile,
  type FeatureWallMediaTile,
  type FeatureWallMediaTileId
} from './feature-wall-tiles'
import { MANAGED_ORCA_RUNTIME_PROFILE, type OrcaRuntimeProfile } from './runtime-profile'

export type FeatureWallWorkflowId =
  | 'tasks'
  | 'workspaces'
  | 'agents-orchestration'
  | 'workbench'
  | 'review'

export type FeatureWallWorkflow = {
  id: FeatureWallWorkflowId
  title: string
  meta: string
  lede: string
  primaryTileId: FeatureWallMediaTileId
  relatedTileIds: readonly FeatureWallMediaTileId[]
  docsUrl: string
}

export const FEATURE_WALL_WORKFLOWS: readonly FeatureWallWorkflow[] = [
  {
    id: 'workspaces',
    title: 'Workspaces',
    meta: 'Isolated work · Context kept together',
    lede: 'Orca splits each task into an isolated workspace so agents can run in parallel.',
    primaryTileId: 'tile-01',
    relatedTileIds: ['tile-10'],
    docsUrl: 'https://www.onorca.dev/docs/model/worktrees'
  },
  {
    id: 'tasks',
    title: 'Tasks',
    meta: 'GitHub · Linear',
    lede: 'Start work directly from GitHub or Linear.',
    primaryTileId: 'tile-03',
    relatedTileIds: [],
    docsUrl: 'https://www.onorca.dev/docs/review/linear'
  },
  {
    id: 'agents-orchestration',
    title: 'Agents',
    meta: 'Agents · Usage · Orca CLI',
    lede: 'Run several agents at once, track their progress, and let automation drive Orca when it helps.',
    primaryTileId: 'tile-04',
    relatedTileIds: ['tile-11', 'tile-09'],
    docsUrl: 'https://www.onorca.dev/docs/agents/supported'
  },
  {
    id: 'workbench',
    title: 'Workbench',
    meta: 'Terminal · Editor · Browser · Files',
    lede: 'Bring your terminal setup into Orca, then split panes to keep servers, tests, logs, and agents running side by side.',
    primaryTileId: 'tile-02',
    relatedTileIds: ['tile-07', 'tile-05', 'tile-12'],
    docsUrl: 'https://www.onorca.dev/docs/terminal'
  },
  {
    id: 'review',
    title: 'Code Review',
    meta: 'Diffs · Comments · PRs',
    lede: 'Review what changed, leave focused feedback, and send it back to the agent.',
    primaryTileId: 'tile-08',
    relatedTileIds: [],
    docsUrl: 'https://www.onorca.dev/docs/review/annotate-ai-diff'
  }
] as const

export const FEATURE_WALL_WORKFLOW_IDS = FEATURE_WALL_WORKFLOWS.map(
  (w) => w.id
) as readonly FeatureWallWorkflowId[]

const TILE_BY_ID = new Map(
  FEATURE_WALL_TILES.filter(isFeatureWallMediaTile).map((tile) => [tile.id, tile])
)

export function getFeatureWallMediaTile(id: FeatureWallMediaTileId): FeatureWallMediaTile | null {
  return TILE_BY_ID.get(id) ?? null
}

export const DEFAULT_FEATURE_WALL_WORKFLOW_ID: FeatureWallWorkflowId = 'workspaces'

/**
 * Workflows owned by the external control plane in managed execution. The
 * agents/orchestration tour surface is never user-reachable there, so it is
 * removed from the rail entirely (rather than shown as a dead end).
 */
const MANAGED_HIDDEN_FEATURE_WALL_WORKFLOW_IDS: readonly FeatureWallWorkflowId[] = [
  'agents-orchestration'
]

/**
 * Filters the feature-wall workflow list for the active runtime profile. In
 * managed execution the orchestration workflow is dropped so no link or rail
 * entry points at a surface the renderer hides. Default execution keeps the
 * full list. Pure and side-effect free so it can be memoized at the single
 * supply source (FeatureWallTourSurface) and threaded down.
 */
export function filterFeatureWallWorkflowsForRuntimeProfile(
  runtimeProfile: OrcaRuntimeProfile,
  workflows: readonly FeatureWallWorkflow[]
): readonly FeatureWallWorkflow[] {
  if (runtimeProfile !== MANAGED_ORCA_RUNTIME_PROFILE) {
    return workflows
  }
  return workflows.filter(
    (workflow) => !MANAGED_HIDDEN_FEATURE_WALL_WORKFLOW_IDS.includes(workflow.id)
  )
}
