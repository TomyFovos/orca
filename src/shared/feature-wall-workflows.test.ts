import { describe, expect, it } from 'vitest'
import { DEFAULT_ORCA_RUNTIME_PROFILE, MANAGED_ORCA_RUNTIME_PROFILE } from './runtime-profile'
import {
  FEATURE_WALL_WORKFLOWS,
  filterFeatureWallWorkflowsForRuntimeProfile
} from './feature-wall-workflows'

describe('filterFeatureWallWorkflowsForRuntimeProfile', () => {
  it('keeps every workflow in default execution', () => {
    const result = filterFeatureWallWorkflowsForRuntimeProfile(
      DEFAULT_ORCA_RUNTIME_PROFILE,
      FEATURE_WALL_WORKFLOWS
    )
    expect(result).toBe(FEATURE_WALL_WORKFLOWS)
    expect(result.map((workflow) => workflow.id)).toContain('agents-orchestration')
  })

  it('drops the agents/orchestration workflow in managed execution', () => {
    const result = filterFeatureWallWorkflowsForRuntimeProfile(
      MANAGED_ORCA_RUNTIME_PROFILE,
      FEATURE_WALL_WORKFLOWS
    )
    expect(result.map((workflow) => workflow.id)).not.toContain('agents-orchestration')
  })

  it('preserves the remaining workflows and their order in managed execution', () => {
    const result = filterFeatureWallWorkflowsForRuntimeProfile(
      MANAGED_ORCA_RUNTIME_PROFILE,
      FEATURE_WALL_WORKFLOWS
    )
    const expectedIds = FEATURE_WALL_WORKFLOWS.map((workflow) => workflow.id).filter(
      (id) => id !== 'agents-orchestration'
    )
    expect(result.map((workflow) => workflow.id)).toEqual(expectedIds)
  })
})
