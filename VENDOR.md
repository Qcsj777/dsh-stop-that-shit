# Vendored upstream

This package vendors the DeepSeek Harness host adapter of
[`lennney/stop-that-shit`](https://github.com/lennney/stop-that-shit) (MIT) and
wraps it in a DSH bundle.

| item | value |
| --- | --- |
| repository | `lennney/stop-that-shit` |
| ref | `main` |
| commit | `e2660f4f1eb3fe3702b28f4c67f82496ac793626` |
| commit subject | Merge pull request #71 — `feat(dsh): add a DeepSeek Harness host adapter` |
| commit date | 2026-10-24 |
| acquired via | `https://codeload.github.com/lennney/stop-that-shit/tar.gz/<sha>` |
| upstream version | `dsh/package.json` 0.2.5 |

## Copied verbatim

| vendor path | package path |
| --- | --- |
| `src/**` | `src/**` |
| `test/dsh-adapter.test.cjs` | `test/dsh-adapter.test.cjs` |
| `skills/**` | `skills/**` |
| `LICENSE` | `LICENSE` |
| `HOST-ADAPTER-CONTRACT.md` | `HOST-ADAPTER-CONTRACT.md` |
| `dsh/lib/bridge.cjs` | `lib/bridge.cjs` (with the diffs below) |

`src/**` is byte-identical to the tarball. The 52 upstream tests in
`test/dsh-adapter.test.cjs` pass unmodified.

Not vendored: the other host adapters (`src/adapters/{claude,codex,hermes,omp,opencode,opencode-v2,pi}-*.cjs`
are kept because `src/` does not load them; the sibling root dirs `hooks/`,
`omp/`, `opencode/`, `pi/`, `schemas/`, `scripts/`, `docs/`, `cases/`, `evals/`,
`server.mjs`, and the per-host plugin manifests were dropped as unused by the
DSH host).

## Diffs to `lib/bridge.cjs`

The package root is the DSH package root, so `bridge.cjs` sits at `lib/` with
`src/` beside it — one level higher than upstream's `dsh/lib/`.

1. **Require path + compat layer** (upstream line 36). Upstream:
   `} = require('../../src/adapters/dsh-hooks.cjs');`
   Now:

   ```js
   const { adapter, parentSessionOf, registerCommands } = require('./dsh-compat.cjs');
   const { applyDshDecision, fromNativeEvent, handleDshHook, resolveRootLineage } = adapter;
   ```

   `lib/dsh-compat.cjs` re-exports every vendor export unchanged and overrides
   only `fromNativeEvent` / `handleDshHook`.

2. **Subagent parent resolution**: `parentOfChild(childId)` now calls
   `parentSessionOf(ctx, childId)` instead of reading
   `getSessionById(childId).header.parentSession`. The header hop is still
   first; the Agent registry and the emitting initiator are fallbacks, and an
   unresolvable parent stays unresolved (it never guesses a root).

3. **`/sts` command**: one added statement at the end of `plugin()` —
   `ctx.effect(() => registerCommands(ctx));` — plus a docblock line naming the
   command.

No upstream behaviour was changed: the decision helpers, event keys, message
shape and the `inject: ['sessions']` contract are untouched.

## Replaced, not modified

- `package.json` — replaced by the DSH bundle manifest of this package
  (`dsh-stop-that-shit`). Upstream name was `stop-that-shit-dsh`.
- `cordis.patch.yml` — same single `insert` row, `id: sts-bridge`,
  `name: 'dsh-stop-that-shit'`, `config: { dataDir: '' }`.

## Added files

| path | purpose |
| --- | --- |
| `lib/dsh-compat.cjs` | DSH 0.2.1-rc.2 payload mapping, parent resolution, `/sts` command |
| `test/dsh-compat.test.cjs` | 18 tests for the compatibility layer |
| `test/bridge-mount.test.cjs` | 6 tests mounting the real bridge on a mock Cordis context |
| `locale/zh.json`, `locale/en.json` | bundle title and description |
| `icon.svg` | 64×64 bundle icon |
| `README.md` | user documentation |
| `VENDOR.md` | this file |

## Known limits of the mapping

`ToolExecutionResult` in DSH 0.2.1-rc.2 carries no lifecycle facts, so the
delegation ledger can only release a reservation when the host proves it:

- `error.info.code === 'ABORTED_BEFORE_DISPATCH'` → the work never started.
- a `tools/pre-execute` denial recorded for the same `callId` → the work was
  denied.
- everything else stays `unknown`, and a delegated tool keeps its reservation
  (by design: a mid-flight `ABORTED` does not prove the child stopped).

## Re-vendoring

1. Resolve the new commit: `https://api.github.com/repos/lennney/stop-that-shit/commits/main`.
2. Download `https://codeload.github.com/lennney/stop-that-shit/tar.gz/<sha>`.
3. Re-copy the rows in "Copied verbatim", re-apply the three diffs above, and
   update the table at the top of this file.
4. `node --test test/dsh-adapter.test.cjs test/dsh-compat.test.cjs test/bridge-mount.test.cjs` must stay green (76 tests), then re-run
   `node --check` over every `.cjs`.