import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  gitCredentialPromptGuardEnv,
  readValidGitConfigEnvCount
} from './git-credential-prompt-env'

const omittedGuardField = 'credential.interactive,credential.guiPrompt'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('gitCredentialPromptGuardEnv', () => {
  it.each([
    [
      { GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Bearer secret' },
      'missing-count-with-indexed-entries',
      undefined
    ],
    [
      {
        GIT_CONFIG_COUNT: 'broken',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: 'Authorization: Bearer secret'
      },
      'malformed-count',
      undefined
    ],
    [{ GIT_CONFIG_COUNT: '9007199254740992' }, 'unsafe-count', undefined],
    [
      {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: 'Authorization: Bearer secret'
      },
      'indexed-entry-count-mismatch',
      undefined
    ],
    [
      {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: 'Authorization: Bearer secret',
        GIT_CONFIG_KEY_1: 'safe.directory',
        GIT_CONFIG_VALUE_2: '/repo'
      },
      'missing-indexed-entry',
      '1'
    ]
  ] as const)('records rule %s without appending config guards', (env, rule, index) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const guarded = gitCredentialPromptGuardEnv(env)

    expect(readValidGitConfigEnvCount(env)).toBeNull()
    expect(guarded.GIT_TERMINAL_PROMPT).toBe('0')
    expect(guarded.GCM_INTERACTIVE).toBe('never')
    expect(Object.values(guarded)).not.toContain('credential.interactive')
    expect(Object.values(guarded)).not.toContain('credential.guiPrompt')
    expect(warn).toHaveBeenCalledTimes(1)

    const message = String(warn.mock.calls[0][0])
    expect(message).toContain('layer=git_config_env')
    expect(message).toContain(`field=${omittedGuardField}`)
    expect(message).toContain(`rule=${rule}`)
    expect(message).not.toContain('Authorization: Bearer secret')
    expect(message).not.toContain('http.extraHeader')
    expect(message).toContain(index === undefined ? 'rule=' : `index=${index}`)
  })

  it('records a dangling indexed position without logging its key or value', () => {
    const env = new Proxy(
      {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: 'Authorization: Bearer secret',
        GIT_CONFIG_KEY_01: 'credential.helper',
        GIT_CONFIG_VALUE_01: 'sensitive-helper'
      },
      {
        get(target, property, receiver) {
          if (property === 'GIT_CONFIG_KEY_1') {
            return 'safe.directory'
          }
          if (property === 'GIT_CONFIG_VALUE_1') {
            return '/repo'
          }
          return Reflect.get(target, property, receiver)
        }
      }
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    gitCredentialPromptGuardEnv(env)

    const message = String(warn.mock.calls[0][0])
    expect(readValidGitConfigEnvCount(env)).toBeNull()
    expect(message).toContain('rule=dangling-index')
    expect(message).toContain('index=01')
    expect(message).not.toContain('credential.helper')
    expect(message).not.toContain('sensitive-helper')
  })

  it('does not record a valid inherited config and appends both config guards', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const guarded = gitCredentialPromptGuardEnv({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '/repo'
    })

    expect(guarded.GIT_CONFIG_COUNT).toBe('3')
    expect(guarded.GIT_CONFIG_KEY_1).toBe('credential.interactive')
    expect(guarded.GIT_CONFIG_VALUE_1).toBe('false')
    expect(guarded.GIT_CONFIG_KEY_2).toBe('credential.guiPrompt')
    expect(guarded.GIT_CONFIG_VALUE_2).toBe('false')
    expect(warn).not.toHaveBeenCalled()
  })

  it('records once and preserves win32 WSLENV config selection on degradation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const guarded = gitCredentialPromptGuardEnv(
      { GIT_CONFIG_COUNT: 'broken', GIT_CONFIG_KEY_0: 'credential.helper' },
      'win32'
    )

    expect(warn).toHaveBeenCalledTimes(1)
    expect(guarded.WSLENV?.split(':')).toEqual(
      expect.arrayContaining(['GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE'])
    )
    expect(guarded.WSLENV).not.toContain('GIT_CONFIG_')
  })

  it('keeps a valid indexed config protocol in win32 WSLENV', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const guarded = gitCredentialPromptGuardEnv(
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: '/repo'
      },
      'win32'
    )

    expect(guarded.WSLENV?.split(':')).toEqual(
      expect.arrayContaining([
        'GIT_TERMINAL_PROMPT',
        'GCM_INTERACTIVE',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
        'GIT_CONFIG_KEY_1',
        'GIT_CONFIG_VALUE_1',
        'GIT_CONFIG_KEY_2',
        'GIT_CONFIG_VALUE_2'
      ])
    )
    expect(warn).not.toHaveBeenCalled()
  })
})
