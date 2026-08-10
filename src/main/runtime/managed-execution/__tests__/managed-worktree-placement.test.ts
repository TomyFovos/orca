import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import {
  computeWorktreePath,
  getWorktreeCreationLayout,
  getWorktreePathSettings
} from '../../../ipc/worktree-logic'
import type { RpcFailure } from '../../rpc/core'
import { mapRuntimeError } from '../../rpc/errors'
import { MANAGED_ORCA_RUNTIME_PROFILE, setProcessRuntimeProfile } from '../../runtime-profile'
import {
  assertManagedWorktreePlacement,
  MANAGED_WORKTREE_ROOT_ENV,
  ManagedWorktreePlacementError,
  type ManagedWorktreePlacementRejection,
  type ManagedWorktreePlacementRejectionCode,
  resolveManagedWorktreeRoot
} from '../managed-worktree-placement'

const isPosix = process.platform !== 'win32'

const createdTempDirs: string[] = []

/** A base whose ancestors are world-traversable, as an isolated worker's UID requires. */
function makeReachableBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'orca-managed-worktree-'))
  createdTempDirs.push(base)
  // mkdtemp always creates 0700; a managed root has to be reachable, so widen the fixture itself.
  chmodSync(base, 0o755)
  return base
}

function makeReachableRoot(): string {
  const root = join(makeReachableBase(), 'workspaces')
  mkdirSync(root, { mode: 0o755 })
  return root
}

const localRepo = { path: '/srv/repos/alpha', worktreeBasePath: undefined } as Pick<
  Repo,
  'path' | 'worktreeBasePath'
>
const settings = { workspaceDir: `${homedir()}/orca/workspaces`, nestWorkspaces: false }

function envWith(root?: string): NodeJS.ProcessEnv {
  return { HOME: homedir(), ...(root === undefined ? {} : { [MANAGED_WORKTREE_ROOT_ENV]: root }) }
}

afterEach(() => {
  setProcessRuntimeProfile('default')
  delete process.env[MANAGED_WORKTREE_ROOT_ENV]
  vi.restoreAllMocks()
})

afterEach(() => {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop()!
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('default profile は一切変化しない', () => {
  beforeEach(() => {
    setProcessRuntimeProfile('default')
  })

  it('managed root が未設定でも worktree 作成を拒否しない', () => {
    expect(() => assertManagedWorktreePlacement('local worktree creation')).not.toThrow()
  })

  it('managed root が設定されていても配置設定を書き換えない', () => {
    process.env[MANAGED_WORKTREE_ROOT_ENV] = makeReachableRoot()

    expect(getWorktreePathSettings(localRepo, settings)).toEqual({
      workspaceDir: settings.workspaceDir,
      nestWorkspaces: false
    })
    expect(computeWorktreePath('feature', localRepo.path, settings)).toBe(
      `${settings.workspaceDir}/feature`
    )
  })

  it('per-repo worktreeBasePath が既存どおり優先される', () => {
    process.env[MANAGED_WORKTREE_ROOT_ENV] = makeReachableRoot()

    expect(
      getWorktreePathSettings(
        { path: '/srv/repos/alpha', worktreeBasePath: '/data/alpha-wt' },
        settings
      )
    ).toEqual({ workspaceDir: '/data/alpha-wt', nestWorkspaces: false })
  })
})

describe('managed profile は設定された root へ配置する', () => {
  beforeEach(() => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
  })

  it('workspaceDir を managed root へ差し替え、repo 名で必ず入れ子にする', () => {
    const root = makeReachableRoot()
    process.env[MANAGED_WORKTREE_ROOT_ENV] = root

    // nestWorkspaces:false の設定でも入れ子にする — 単一 root を全 repo が共有するため。
    expect(getWorktreePathSettings(localRepo, settings)).toEqual({
      workspaceDir: root,
      nestWorkspaces: true
    })
    expect(
      computeWorktreePath('feature', localRepo.path, getWorktreePathSettings(localRepo, settings))
    ).toBe(`${root}/alpha/feature`)
  })

  it('per-repo worktreeBasePath では managed root から出られない', () => {
    const root = makeReachableRoot()
    process.env[MANAGED_WORKTREE_ROOT_ENV] = root
    const repo = { path: '/srv/repos/alpha', worktreeBasePath: `${homedir()}/escape` }

    expect(getWorktreePathSettings(repo, settings).workspaceDir).toBe(root)
    expect(getWorktreeCreationLayout(repo, settings)).toEqual({ path: root, nestWorkspaces: true })
  })

  it('到達可能な root なら作成を拒否しない', () => {
    process.env[MANAGED_WORKTREE_ROOT_ENV] = makeReachableRoot()

    expect(() => assertManagedWorktreePlacement('local worktree creation')).not.toThrow()
  })
})

describe('managed profile は解決できない配置先を理由付きで拒否する', () => {
  beforeEach(() => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
  })

  it('未設定は既定値へ落とさず拒否する', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => assertManagedWorktreePlacement('local worktree creation', {}, envWith())).toThrow(
      ManagedWorktreePlacementError
    )
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `operation=local worktree creation code=unset field=${MANAGED_WORKTREE_ROOT_ENV} rule=required-in-managed-profile`
      )
    )
  })

  it('相対パスを拒否する', () => {
    expect(resolveManagedWorktreeRoot(envWith('relative/workspaces')).rejection).toMatchObject({
      code: 'not_absolute',
      rule: 'absolute-path'
    })
  })

  it('存在しない配置先を拒否する', () => {
    expect(
      resolveManagedWorktreeRoot(envWith(join(makeReachableBase(), 'absent'))).rejection
    ).toMatchObject({ code: 'missing', rule: 'exists' })
  })

  it('ディレクトリでない配置先を拒否する', () => {
    const file = join(makeReachableBase(), 'not-a-dir')
    writeFileSync(file, '')

    expect(resolveManagedWorktreeRoot(envWith(file)).rejection).toMatchObject({
      code: 'not_a_directory',
      rule: 'is-directory'
    })
  })

  it('$HOME 配下を拒否する', () => {
    const home = makeReachableBase()
    const inside = join(home, 'orca', 'workspaces')
    mkdirSync(inside, { recursive: true, mode: 0o755 })

    expect(
      resolveManagedWorktreeRoot({ [MANAGED_WORKTREE_ROOT_ENV]: inside, HOME: home }).rejection
    ).toMatchObject({ code: 'inside_home', rule: 'outside-home' })
  })

  it.skipIf(!isPosix)('$HOME を指す symlink でも拒否する — realpath 後に判定する', () => {
    const home = makeReachableBase()
    const inside = join(home, 'workspaces')
    mkdirSync(inside, { mode: 0o755 })
    const link = join(makeReachableBase(), 'link-to-home-workspaces')
    symlinkSync(inside, link)

    expect(
      resolveManagedWorktreeRoot({ [MANAGED_WORKTREE_ROOT_ENV]: link, HOME: home }).rejection
    ).toMatchObject({ code: 'inside_home' })
  })

  it.skipIf(!isPosix)('traverse できない祖先を、その祖先のパスとともに拒否する', () => {
    const base = makeReachableBase()
    const root = join(base, 'workspaces')
    mkdirSync(root, { mode: 0o755 })
    // $HOME が 700 であるのと同じ状態を作る。緩めるのではなく拒否できることを示す。
    chmodSync(base, 0o700)

    const rejection = resolveManagedWorktreeRoot(envWith(root)).rejection
    expect(rejection).toMatchObject({
      code: 'not_traversable',
      rule: 'ancestors-world-traversable'
    })
    expect(rejection?.detail).toContain(base)
  })

  it('managed root が解決できない間は作成が拒否される', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const base = makeReachableBase()
    const root = join(base, 'workspaces')
    mkdirSync(root, { mode: 0o755 })
    process.env[MANAGED_WORKTREE_ROOT_ENV] = join(root, 'never-created')

    expect(() => assertManagedWorktreePlacement('runtime worktree creation')).toThrow(
      ManagedWorktreePlacementError
    )
  })
})

describe('検証できないホストは managed profile で fail-closed', () => {
  beforeEach(() => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
  })

  it('SSH ホストの配置は拒否し、理由を記録する', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env[MANAGED_WORKTREE_ROOT_ENV] = makeReachableRoot()

    expect(() =>
      assertManagedWorktreePlacement('remote worktree creation', { hostUnvalidatable: true })
    ).toThrow(ManagedWorktreePlacementError)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('code=host_unvalidatable field=repo.path rule=local-posix-host-only')
    )
  })

  it('SSH repo の配置設定は managed root を使わない', () => {
    const root = makeReachableRoot()
    process.env[MANAGED_WORKTREE_ROOT_ENV] = root
    const sshRepo = {
      path: '/home/remote/repos/alpha',
      worktreeBasePath: undefined,
      connectionId: 'ssh-1'
    }

    expect(getWorktreePathSettings(sshRepo, settings).workspaceDir).not.toBe(root)
  })

  it('default profile では SSH ホストでも拒否しない', () => {
    setProcessRuntimeProfile('default')

    expect(() =>
      assertManagedWorktreePlacement('remote worktree creation', { hostUnvalidatable: true })
    ).not.toThrow()
  })
})

describe('拒否理由は RPC 境界を越えて機械可読なまま届く', () => {
  const runsAsRoot = process.getuid?.() === 0

  beforeEach(() => {
    setProcessRuntimeProfile(MANAGED_ORCA_RUNTIME_PROFILE)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  function rejectionThroughRpc(
    options: Parameters<typeof assertManagedWorktreePlacement>[1],
    env: NodeJS.ProcessEnv
  ): RpcFailure['error'] {
    let thrown: unknown
    try {
      assertManagedWorktreePlacement('local worktree creation', options, env)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ManagedWorktreePlacementError)
    return mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, thrown).error
  }

  // 8 種すべてを列挙する。1 つでも構造化されずに落ちれば、拒否理由は message 文字列に
  // 退化しており、呼び出し元は理由を機械的に区別できない。
  type RejectionCase = {
    code: ManagedWorktreePlacementRejectionCode
    rule: string
    skip?: boolean
    build: () => { options?: { hostUnvalidatable?: boolean }; env: NodeJS.ProcessEnv }
  }

  const cases: RejectionCase[] = [
    { code: 'unset', rule: 'required-in-managed-profile', build: () => ({ env: envWith() }) },
    {
      code: 'not_absolute',
      rule: 'absolute-path',
      build: () => ({ env: envWith('relative/workspaces') })
    },
    {
      code: 'missing',
      rule: 'exists',
      build: () => ({ env: envWith(join(makeReachableBase(), 'absent')) })
    },
    {
      code: 'not_a_directory',
      rule: 'is-directory',
      build: () => {
        const file = join(makeReachableBase(), 'not-a-dir')
        writeFileSync(file, '')
        return { env: envWith(file) }
      }
    },
    {
      code: 'inside_home',
      rule: 'outside-home',
      build: () => {
        const home = makeReachableBase()
        const inside = join(home, 'workspaces')
        mkdirSync(inside, { mode: 0o755 })
        return { env: { [MANAGED_WORKTREE_ROOT_ENV]: inside, HOME: home } }
      }
    },
    {
      code: 'not_traversable',
      rule: 'ancestors-world-traversable',
      skip: !isPosix,
      build: () => {
        const base = makeReachableBase()
        const root = join(base, 'workspaces')
        mkdirSync(root, { mode: 0o755 })
        chmodSync(base, 0o700)
        return { env: envWith(root) }
      }
    },
    {
      code: 'not_writable_by_orca',
      rule: 'writable-by-orca',
      // root は全パーミッションを迂回するため、この拒否を再現できない。
      skip: !isPosix || runsAsRoot,
      build: () => {
        const root = join(makeReachableBase(), 'workspaces')
        mkdirSync(root, { mode: 0o555 })
        return { env: envWith(root) }
      }
    },
    {
      code: 'host_unvalidatable',
      rule: 'local-posix-host-only',
      build: () => ({ options: { hostUnvalidatable: true }, env: envWith() })
    }
  ]

  for (const testCase of cases) {
    it.skipIf(testCase.skip)(`${testCase.code} を data として渡す`, () => {
      const { options, env } = testCase.build()

      const error = rejectionThroughRpc(options, env)

      expect(error.code).toBe('managed_worktree_placement_unavailable')
      expect(error.data).toMatchObject({ code: testCase.code, rule: testCase.rule })
      expect((error.data as ManagedWorktreePlacementRejection).field).toBeTruthy()
      expect((error.data as ManagedWorktreePlacementRejection).detail).toBeTruthy()
    })
  }

  it('列挙が拒否コードの全種を覆っている', () => {
    const covered = new Set(cases.map((testCase) => testCase.code))
    const declared: readonly ManagedWorktreePlacementRejectionCode[] = [
      'unset',
      'not_absolute',
      'inside_home',
      'missing',
      'not_a_directory',
      'not_traversable',
      'not_writable_by_orca',
      'host_unvalidatable'
    ]

    expect([...covered].sort()).toEqual([...declared].sort())
  })
})
