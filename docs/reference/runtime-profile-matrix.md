# Runtime Profile Matrix (managed vs default)

## Scope

Orca runs under one of two startup runtime profiles, fixed for the lifetime of
the process before any window is created:

- `default` — the standalone, user-driven product. Orchestration (the Orca CLI
  and the agent skill that let agents coordinate through Orca) is a feature the
  user discovers, installs, and manages themselves. Every orchestration surface
  is visible.
- `managed` — Orca is driven by an external control plane. The orchestration
  bundle is owned by that control plane, not by the user, so the renderer hides
  every user-facing orchestration *setup and promotion* surface. Running-agent
  observability is preserved (see [Link Handling](#link-handling)).

The profile is a startup constant, not a runtime toggle. Nothing switches
profiles after launch, and the renderer never guesses it.

The hiding in `managed` is a consistency measure, not a security boundary. The
authoritative enforcement lives in the main process (skill delivery is filtered
there); the renderer hiding keeps the UI from advertising actions that the
control plane owns. Do not treat a hidden button as a defense.

## Environment Resolution

The profile comes from the `ORCA_RUNTIME_PROFILE` environment variable, resolved
once in the main process at startup (`resolveOrcaRuntimeProfile` in
`src/shared/runtime-profile.ts`):

| `ORCA_RUNTIME_PROFILE` | Resolved profile | Behavior                                            |
| ---------------------- | ---------------- | --------------------------------------------------- |
| _(absent)_             | `default`        | Legacy-compatible default for existing installs.    |
| `default`              | `default`        | Explicit standalone mode.                           |
| `managed`              | `managed`        | External-control-plane mode.                        |
| any other value        | _(rejected)_     | Throws `InvalidOrcaRuntimeProfileError`; startup fails closed rather than silently picking the permissive side. |

An absent variable resolves to `default` so today's installs are unchanged. A
supplied-but-unknown value is rejected outright: silently mapping a typo to
`default` would weaken a managed boundary, so startup calls
`resolveOrcaRuntimeProfileAtStartup` with a fail-closed handler instead.

## Managed execution authority registry

The managed execution endpoint is opened only after the main process loads the
authority registry at startup. Set `ORCA_MANAGED_AUTHORITY_REGISTRY_PATH` to a
JSON file containing an `authority_id` to Ed25519 SPKI PEM mapping; the format
and handling rules are documented in [`config/managed-execution/README.md`](../../config/managed-execution/README.md).

The registry is process-private and immutable after startup. It has no runtime
registration, revocation, or mutable-map API. To add or revoke execution
authority, change the protected configuration file and restart Orca. Missing,
empty, or invalid configuration leaves the managed endpoint closed rather than
opening a listener that rejects every request. The registry file is an
authorization policy: write access to it grants managed execution authority and
must be protected accordingly.

The managed endpoint defaults to loopback port `6770` (override with
`ORCA_MANAGED_ENDPOINT_PORT`). This is separate from Orca's production runtime
RPC on `6768`; `6769` is reserved for the development WebSocket path and test
fixtures rather than a managed listener.

## Managed worktree placement

In the managed profile every locally created worktree is placed under the root
named by `ORCA_MANAGED_WORKTREE_ROOT`, overriding both the global `workspaceDir`
setting and any per-repo `worktreeBasePath`. Repos are always nested by name
below that root, because one root is shared by all of them.

The reason the default placement cannot be reused: an isolated worker runs under
a foreign UID (100000) and has to reach the worktree as its own cwd. A `$HOME`
of mode 700 is not traversable by that UID, so any root inside `$HOME` is
unreachable no matter where the agent binary lives.

`src/main/runtime/managed-execution/managed-worktree-placement.ts` resolves the
root once and rejects it — recording `code`, `field`, and `rule` on stderr —
when it is unset, relative, missing, not a directory, inside `$HOME` (after
`realpath`, so a symlink cannot slip past), not writable by Orca, or has any
ancestor from `/` downward that lacks `o+x`. There is no default to fall back
to: creation fails closed. Loosening permissions is not an accepted remedy;
relocate the root instead.

On POSIX hosts, `o+x` is the deliberate reachability criterion, based only on
traditional permission bits; Orca does not read POSIX ACLs. A root or ancestor
made traversable for the worker solely by ACL entries, with its world execute
bit cleared, is rejected as `not_traversable` even if the worker can reach it.
For example, `drwxrwxr-x+` passes because `o+x` is set, not because an ACL is
present. Correct ACL interpretation requires evaluating mask, effective, and
default ACL semantics; the risk of incorrectly accepting an unreachable root
outweighs the value of that check.

Traversability is necessary but not sufficient. Orca cannot decide whether the
worker's UID may write inside the root, because `fs.access` answers for the
calling process only. That check belongs to whoever provisions the root.

Remote (SSH) and WSL worktree creation is refused in the managed profile
(`host_unvalidatable`): the root would live on another host or namespace where
none of these checks can run, and the existing fallback places the worktree
beside the remote repo — that is, inside the remote `$HOME`.

The `default` profile is unaffected in every one of these paths.

## Synchronous Bridge

The renderer reads the profile **synchronously**. An asynchronous read would
leave an undetermined window between first paint and IPC resolution during which
managed mode could briefly render orchestration UI it must not. Because the
profile is fixed before any window exists, a blocking read is safe (the same
pattern as `settings:get-sync`):

1. Main: `ipcMain.on('app:getRuntimeProfileSync')` sets `event.returnValue` from
   `getProcessRuntimeProfile()` (`src/main/ipc/app.ts`).
2. Preload: `getRuntimeProfileSync()` calls `ipcRenderer.sendSync`
   (`src/preload/index.ts`, typed in `src/preload/api-types.ts`).
3. Renderer: `readRuntimeProfileSync()` (`src/renderer/src/lib/runtime-profile-access.ts`)
   performs the read once and caches it in a module singleton, so renders do not
   pay a blocking round-trip per consultation. The `useRuntimeProfile()` hook
   returns `OrcaRuntimeProfile` directly — it never returns a `Promise`, and
   callers never handle an undetermined state.

## UI Hiding Map

Each surface reads the profile through `useRuntimeProfile()` /
`isManagedRuntimeProfile()` and removes the orchestration entry point in
`managed`. `default` keeps the full surface.

| Surface                  | File                                                        | What `managed` removes                                   |
| ------------------------ | ----------------------------------------------------------- | -------------------------------------------------------- |
| Settings navigation      | `src/renderer/src/hooks/useSettingsNavigationMetadata.ts`    | The `orchestration` settings section.                    |
| Feature Wall tour        | `src/shared/feature-wall-workflows.ts` (applied in `FeatureWallTourSurface.tsx`) | The `agents-orchestration` workflow rail entry, filtered once at the supply source and threaded to the rail, index math, and continue navigation. |
| Floating terminal        | `src/renderer/src/components/floating-terminal/FloatingTerminalPanel.tsx` | The "Enable orchestration" banner and its setup dialog.  |
| Onboarding checklist     | `src/renderer/src/components/onboarding/FeatureSetupChecklist.tsx` | The `orchestration` setup row.                           |
| Feature tips             | `src/shared/feature-tips.ts`                                 | The `orca-cli` tip; the startup gate and modal state take the profile as a required argument. |

Filtering happens at the single supply source for each surface and the result is
threaded down, so visible items, index math, and keyboard navigation cannot
drift apart.

## Progress N/A Rule

Setup-progress surfaces ask "is the orchestration skill installed?" In `managed`
the skill is never user-installable, so the honest answer is N/A — treated as
satisfied so progress can complete. This rule is applied once, at the single
supply source every progress consumer reads (`useInstalledAgentSkillNames` in
`src/renderer/src/hooks/useInstalledAgentSkills.ts`, via
`resolveOrchestrationSkillStateForRuntime`):

- `default`: the derived state is returned unchanged.
- `managed` with the orchestration skill among the candidates: the derived flags
  are normalized to `installed: true`, `loading: false`, `settled: true`,
  `error: null`. The raw `skills` / `sources` / `refresh` fields are preserved
  for honesty; only the derived flags that drive progress are normalized.

Because the rule lives at the supply source, the downstream progress calculators
(settings setup guide, feature-wall completion, session depth, capability setup
status, setup-guide readiness) need no individual edits — and none can forget the
rule and leave a "progress that never fills" UI.

## Link Handling

Hiding a setup surface must not leave a link pointing at something that no
longer exists. The orchestration *setup/promotion* entry points above are removed
entirely (not left as dead links). The following stay visible in `managed`
because they are observability for **running** agents, not user-invokable
orchestration setup — and each was verified to resolve to a live destination:

- **Terminal pane orchestration task links** focus the running agent's terminal;
  they do not navigate to a hidden setup screen.
- **Dashboard agent-row orchestration lineage** opens the agent's worktree tab
  and agent pane, both of which remain available.
- **Worktree-agent orchestration batch/index** are pure display selectors with no
  navigation target.

Display-only orchestration metadata on running agents (and any state that does
not require a user action) is intentionally kept: removing it would break the
observability that `managed` is meant to preserve. If a future change removes a
destination, the corresponding link must be disabled or moved to the hidden side
in the same change.

## Known Limitations

These are accepted constraints of the execution boundary (enforced in the main
process, PR 2). They are documented here so the renderer UI hiding is not
mistaken for the whole boundary:

- `orca skills ... --dry-run` still displays the pre-filter command string in
  `managed`. Execution is rejected, so this is not a boundary hole — the dry run
  only prints what would have run.
- Direct raw `npx` execution in a terminal is not command-parsed and is therefore
  not intercepted. Orca cannot safely distinguish arbitrary shell use from `npx`
  without breaking the terminal substrate that `managed` must preserve; the
  authoritative control point is the orchestration skill-delivery filter, not raw
  shell parsing.

## Fail-Closed Guarantee

When the profile cannot be determined, the renderer resolves to `managed` — the
restrictive side. `readRuntimeProfileSync()` returns `managed` if the preload
bridge is missing, if the synchronous IPC throws, or if the value is not exactly
`default` or `managed`. It never falls back to `default` on uncertainty: hiding
orchestration surfaces in an ambiguous state is safe, exposing them is not.

This mirrors the main-process rule (an unknown `ORCA_RUNTIME_PROFILE` fails
startup) and the skill-delivery rule (orchestration delivery is skipped in
`managed`). When adding a new profile-gated surface, read the profile through
`useRuntimeProfile()` / `isManagedRuntimeProfile()` so it inherits this
guarantee; do not introduce an undetermined state or a permissive default.
