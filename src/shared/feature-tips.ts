import {
  hasFeatureInteraction,
  type FeatureInteractionId,
  type FeatureInteractionState
} from './feature-interactions'
import { MANAGED_ORCA_RUNTIME_PROFILE, type OrcaRuntimeProfile } from './runtime-profile'

export type FeatureTipId = 'voice-dictation' | 'orca-cli' | 'cmd-j-palette'

export type FeatureTipPriority = 'new' | 'unseen'

export type FeatureTipAction = 'enable-voice' | 'setup-cli' | 'learn-cmd-j-palette'

export type FeatureTip = {
  id: FeatureTipId
  priority: FeatureTipPriority
  eyebrow: string
  title: string
  description: string
  action: FeatureTipAction
  ctaLabel: string
  /** Feature interactions that mean this tip is no longer useful to show. */
  completedByFeatureInteractions?: readonly FeatureInteractionId[]
}

export type CompletedFeatureTipState = {
  cliInstalled: boolean
  voiceDictationEnabled: boolean
  featureInteractions?: FeatureInteractionState
}

export const FEATURE_TIPS = [
  {
    id: 'orca-cli',
    priority: 'new',
    eyebrow: 'Tip',
    title: 'Let agents drive Orca with the Orca CLI',
    description: 'Enable agents to coordinate child worktrees and communicate between worktrees.',
    action: 'setup-cli',
    ctaLabel: 'Install CLI & Skills',
    completedByFeatureInteractions: []
  },
  {
    id: 'cmd-j-palette',
    priority: 'new',
    eyebrow: 'Tip',
    // Why: "<shortcut>" is a placeholder token; the cmd-j dialog splits the
    // title on it and inlines the live, platform-correct keybinding as a <kbd>.
    title: 'Jump to a worktree with <shortcut>',
    description:
      'Search worktrees, switch tabs, tweak settings, or spin up a new worktree, all without leaving the keyboard.',
    action: 'learn-cmd-j-palette',
    ctaLabel: 'Got it',
    completedByFeatureInteractions: []
  },
  {
    id: 'voice-dictation',
    priority: 'unseen',
    eyebrow: 'Tip',
    title: 'Dictate into any pane',
    description: 'Start voice dictation in any focused pane, then use the shortcut again to stop.',
    action: 'enable-voice',
    ctaLabel: 'Set up voice dictation',
    completedByFeatureInteractions: ['voice-dictation']
  }
] as const satisfies readonly FeatureTip[]

export const FEATURE_TIP_IDS = FEATURE_TIPS.map((tip) => tip.id)

/**
 * Tips that drive orchestration setup. The `orca-cli` tip installs the Orca CLI
 * and enables the orchestration skill, whose visual and setup terminal are all
 * orchestration surfaces. In managed execution that bundle is owned by the
 * external control plane, so the tip is removed rather than offering a setup
 * path that cannot complete.
 */
const MANAGED_HIDDEN_FEATURE_TIP_IDS: readonly FeatureTipId[] = ['orca-cli']

export function isFeatureTipHiddenForRuntimeProfile(
  runtimeProfile: OrcaRuntimeProfile,
  tipId: FeatureTipId
): boolean {
  return (
    runtimeProfile === MANAGED_ORCA_RUNTIME_PROFILE &&
    MANAGED_HIDDEN_FEATURE_TIP_IDS.includes(tipId)
  )
}

/**
 * Filters the tip catalog for the active runtime profile (see
 * `isFeatureTipHiddenForRuntimeProfile`). Pure so it can be applied at the
 * renderer chokepoints that decide which tip shows.
 */
export function filterFeatureTipsForRuntimeProfile(
  runtimeProfile: OrcaRuntimeProfile,
  tips: readonly FeatureTip[]
): FeatureTip[] {
  if (runtimeProfile !== MANAGED_ORCA_RUNTIME_PROFILE) {
    return [...tips]
  }
  return tips.filter((tip) => !MANAGED_HIDDEN_FEATURE_TIP_IDS.includes(tip.id))
}

export function isFeatureTipId(value: unknown): value is FeatureTipId {
  return typeof value === 'string' && FEATURE_TIP_IDS.includes(value as FeatureTipId)
}

export function normalizeFeatureTipIds(value: unknown): FeatureTipId[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<FeatureTipId>()
  for (const item of value) {
    if (isFeatureTipId(item)) {
      seen.add(item)
    }
  }
  return [...seen]
}

export function getCompletedFeatureTipIds(state: CompletedFeatureTipState): Set<FeatureTipId> {
  const completedIds = new Set<FeatureTipId>()
  if (state.cliInstalled) {
    completedIds.add('orca-cli')
  }
  if (state.voiceDictationEnabled) {
    completedIds.add('voice-dictation')
  }
  for (const tip of FEATURE_TIPS) {
    if (
      tip.completedByFeatureInteractions?.some((id) =>
        hasFeatureInteraction(state.featureInteractions, id)
      )
    ) {
      completedIds.add(tip.id)
    }
  }
  return completedIds
}

export function getOrderedUnseenFeatureTips(args: {
  seenTipIds: ReadonlySet<FeatureTipId>
  completedTipIds?: ReadonlySet<FeatureTipId>
}): FeatureTip[] {
  const completedTipIds = args.completedTipIds ?? new Set<FeatureTipId>()
  const unseenTips = FEATURE_TIPS.filter(
    (tip) => !args.seenTipIds.has(tip.id) && !completedTipIds.has(tip.id)
  )
  return [
    ...unseenTips.filter((tip) => tip.priority === 'new'),
    ...unseenTips.filter((tip) => tip.priority !== 'new')
  ]
}
