import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { _runtimeProfileAccessForTests } from '@/lib/runtime-profile-access'
import { AgentFeatureSetupStep } from './AgentFeatureSetupStep'

function renderChecklist(): string {
  return renderToStaticMarkup(
    <AgentFeatureSetupStep
      featureSetup={{
        browserUse: true,
        computerUse: true,
        orchestration: true,
        linearTickets: false
      }}
      onFeatureSetupChange={vi.fn()}
      featureSetupCommand={null}
      featureSetupCommandSelection={null}
      setupBusyLabel={null}
      onStartFeatureSetup={vi.fn()}
    />
  )
}

describe('AgentFeatureSetupStep', () => {
  // Why: the profile is read synchronously and fail-closes to managed when no
  // bridge is present. These are default-mode assertions, so pin the profile
  // explicitly rather than letting the fail-closed path hide orchestration.
  afterEach(() => {
    _runtimeProfileAccessForTests.reset()
  })

  it('renders the agent feature setup checklist', () => {
    _runtimeProfileAccessForTests.set('default')
    const html = renderChecklist()

    expect(html).toContain('Agent Browser Use')
    expect(html).toContain('Computer Use')
    expect(html).toContain('Agent Orchestration')
    expect(html).toContain('Linear agent skill')
    expect(html).toContain('Enable capabilities')
    expect(html).toContain('role="checkbox"')
  })

  it('hides the orchestration card in managed execution but keeps the rest', () => {
    _runtimeProfileAccessForTests.set('managed')
    const html = renderChecklist()

    expect(html).not.toContain('Agent Orchestration')
    expect(html).toContain('Agent Browser Use')
    expect(html).toContain('Computer Use')
    expect(html).toContain('Linear agent skill')
  })
})
