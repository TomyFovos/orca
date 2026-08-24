import {
  startManagedExecutionEndpoint as startEndpoint,
  type EndpointConfig,
  type StoredAcceptedReceipt
} from '../endpoint'
import { AttemptIdentityRegistry } from '../attempt-identity-registry'

export type { StoredAcceptedReceipt }

export function startManagedExecutionEndpoint(config: EndpointConfig) {
  if (config.attemptIdentities) {
    return startEndpoint(config)
  }
  const attemptIdentities = new AttemptIdentityRegistry()
  attemptIdentities.register({
    attemptId: 'managed-e2e-attempt',
    backendRef: 'orca-attempt-managed-e2e',
    backendSessionId: 'orca-session-managed-e2e'
  })
  return startEndpoint({ ...config, attemptIdentities })
}
