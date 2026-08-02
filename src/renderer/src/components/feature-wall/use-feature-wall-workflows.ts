import { useMemo } from 'react'
import {
  FEATURE_WALL_WORKFLOWS,
  filterFeatureWallWorkflowsForRuntimeProfile,
  type FeatureWallWorkflow
} from '../../../../shared/feature-wall-workflows'
import { useRuntimeProfile } from '@/hooks/useRuntimeProfile'

// Why: the runtime profile gates whether the orchestration workflow is
// user-reachable. Filter once at this single supply source and thread the
// result down so the rail, index math, and continue navigation can never
// drift from what is actually visible. Memoized on the (session-fixed)
// profile so it is stable across renders.
export function useFeatureWallWorkflows(): readonly FeatureWallWorkflow[] {
  const runtimeProfile = useRuntimeProfile()
  return useMemo(
    () => filterFeatureWallWorkflowsForRuntimeProfile(runtimeProfile, FEATURE_WALL_WORKFLOWS),
    [runtimeProfile]
  )
}
