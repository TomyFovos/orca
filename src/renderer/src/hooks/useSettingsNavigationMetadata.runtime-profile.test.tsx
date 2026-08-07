// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/types'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import { _runtimeProfileAccessForTests } from '@/lib/runtime-profile-access'

const testState = vi.hoisted(() => ({
  settings: null as GlobalSettings | null,
  sections: null as SettingsNavSection[] | null
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: object) => unknown) =>
    selector({
      settings: testState.settings,
      repos: [],
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map()
    })
}))

vi.mock('@/hooks/useLinearProviderConnected', () => ({
  useLinearProviderConnected: () => false
}))

// Why: a non-web, local target keeps useWindowsTerminalCapabilities disabled so
// this test exercises only the runtime-profile gate, not capability fetching.
vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => false
}))

import { useSettingsNavigationMetadata } from './useSettingsNavigationMetadata'

function Probe(): null {
  testState.sections = useSettingsNavigationMetadata()
  return null
}

function sectionIds(): string[] {
  return testState.sections?.map((section) => section.id) ?? []
}

describe('settings navigation runtime profile gating', () => {
  let root: Root

  beforeEach(() => {
    testState.settings = {
      ...getDefaultSettings('/tmp'),
      activeRuntimeEnvironmentId: null
    }
    testState.sections = null
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
    _runtimeProfileAccessForTests.reset()
  })

  it('keeps the orchestration section in default execution', () => {
    _runtimeProfileAccessForTests.set('default')
    act(() => {
      root.render(createElement(Probe))
    })
    expect(sectionIds()).toContain('orchestration')
  })

  it('drops the orchestration section in managed execution but keeps its neighbors', () => {
    _runtimeProfileAccessForTests.set('managed')
    act(() => {
      root.render(createElement(Probe))
    })
    const ids = sectionIds()
    expect(ids).not.toContain('orchestration')
    expect(ids).toContain('agents')
    expect(ids).toContain('computer-use')
  })
})
