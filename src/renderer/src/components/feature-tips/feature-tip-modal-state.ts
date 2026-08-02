import type { GlobalSettings } from '../../../../shared/types'
import type { FeatureInteractionState } from '../../../../shared/feature-interactions'
import type { OrcaRuntimeProfile } from '../../../../shared/runtime-profile'
import {
  FEATURE_TIPS,
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips,
  isFeatureTipHiddenForRuntimeProfile,
  isFeatureTipId,
  type FeatureTip,
  type FeatureTipId
} from '../../../../shared/feature-tips'

export function getFeatureTipForModal(args: {
  cliInstalled: boolean
  modalData: Record<string, unknown>
  runtimeProfile: OrcaRuntimeProfile
  seenTipIds: readonly FeatureTipId[]
  featureInteractions: FeatureInteractionState
  settings: { voice?: GlobalSettings['voice'] } | null | undefined
}): FeatureTip | null {
  const modalTipId = isFeatureTipId(args.modalData.tipId) ? args.modalData.tipId : null
  if (modalTipId) {
    // Why: a stale modal payload (e.g. persisted across a profile switch) must
    // not resurrect a tip the active runtime profile hides.
    if (isFeatureTipHiddenForRuntimeProfile(args.runtimeProfile, modalTipId)) {
      return null
    }
    return FEATURE_TIPS.find((tip) => tip.id === modalTipId) ?? null
  }

  const pendingTip = getOrderedUnseenFeatureTips({
    seenTipIds: new Set(args.seenTipIds),
    completedTipIds: getCompletedFeatureTipIds({
      cliInstalled: args.cliInstalled,
      voiceDictationEnabled: args.settings?.voice?.enabled === true,
      featureInteractions: args.featureInteractions
    })
  }).find((tip) => !isFeatureTipHiddenForRuntimeProfile(args.runtimeProfile, tip.id))

  return pendingTip ?? null
}
