import type { OrcaRuntimeProfile } from '../../../shared/runtime-profile'
import { readRuntimeProfileSync } from '@/lib/runtime-profile-access'

/**
 * Returns the fixed startup runtime profile for the current renderer session.
 *
 * The read is synchronous and never returns a Promise: the profile gates whether
 * orchestration surfaces may render, so an undetermined async state is not
 * allowed. See `readRuntimeProfileSync` for the fail-closed guarantee.
 */
export function useRuntimeProfile(): OrcaRuntimeProfile {
  return readRuntimeProfileSync()
}
