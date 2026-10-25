# Stop That Shit (STS) for DeepSeek Harness

Arms an explicit, per-session scope contract from a prompt directive and audits
every tool call against it. Without a directive the guard is inert: every tool
call is allowed and the only thing the model sees is a short advisory that no
contract is confirmed yet.

This package is a DeepSeek Harness (DSH) plugin bundle. It vendors the upstream
[`lennney/stop-that-shit`](https://github.com/lennney/stop-that-shit) source
(MIT) and adds a thin DSH 0.2.1-rc.2 compatibility layer plus a `/sts` slash
command. See [VENDOR.md](VENDOR.md) for the exact vendored paths and the diffs.

## Install

The harness installs it as a profile bundle; the package ships its own Cordis
patch at `cordis.patch.yml`:

```yaml
- insert:
    - id: sts-bridge
      name: 'dsh-stop-that-shit'
      config:
        dataDir: ''
```

`dataDir` empty means the default state directory
`~/.dsh/stop-that-shit` (`%USERPROFILE%\.dsh\stop-that-shit` on Windows).
Point it somewhere else to separate state per profile.

From GitHub:

```powershell
dsh plugin --profile desktop add github:Qcsj777/dsh-stop-that-shit
```

## Arming from a prompt

The directive must be the **first line** of the user message, introduced by
`$stop-that-shit` (or `$stop-that-shit:`). Everything after `--`, or after a
line break, is task text and is ignored by the parser.

```
$stop-that-shit change lock files=src/**,test/** deps=deny hash=allow agents=4 -- implement the parser
```

| field | values | default | meaning |
| --- | --- | --- | --- |
| mode | `answer` `review` `change` `monitor` `open` | `unconfirmed` | what kind of work was authorized |
| level | `watch` `guard` `lock` `off` | `watch` | how hard violations are stopped |
| `files=` | `glob\|glob\|glob` | unset | file boundary; `src/**` form, not `src/` |
| `deps=` | `allow` `ask` `deny` | `ask` | dependency / package-install authority |
| `hash=` | `allow` `ask` `deny` | `deny` | authority over hash/version pinning changes |
| `agents=` | positive integer | unlimited | delegation budget |

Unknown fields, conflicting duplicates, and a malformed value are rejected with
an explanatory context message; the previous contract stays in force. An
unarmed `$stop-that-shit` line that is not on the first line produces a warning
instead of arming anything.

Runtime directives are whole-prompt commands:

```
$stop-that-shit status
$stop-that-shit runtime [all]
$stop-that-shit explain evt_<uuid>
$stop-that-shit label evt_<uuid> correct|incorrect|inconclusive
```

## The `/sts` command

`/sts` injects exactly the directive text a user would type, as a normal user
message, so it arms through the same path and cannot widen the contract
silently.

```
/sts                                   # same as /sts status
/sts status                            # state, contract fields, authority source
/sts review files=src/** -- look at it  # mode directive with task text
/sts change lock files=src/**,test/** deps=deny hash=allow agents=4
/sts monitor
/sts answer
/sts off                               # disarm, back to watch / no contract
```

`/sts` needs the harness `commands` service. The bridge acquires it through
`ctx.inject(['commands'])`, so a harness without that service still loads and
guards normally — only the command is absent.

## State model

`OFF` — no directive seen yet. `OBSERVING` — a directive was seen but no
mutation authority is confirmed (`watch`). `ARMED` — a contract with an
effective level.

Each tool call is judged against the contract of the **root** session of the
calling session, so a delegated child (root → child → grandchild) is audited
against the root contract. The lineage is walked through the live session store;
if a parent exists but the root cannot be resolved, the call is denied with an
explicit "no verified root session" reason rather than guessed at.

A denial is a real tool denial: the model receives the reason text, the event is
recorded, and the harness still runs `tools/post-execute` with the synthesized
error result.

## Storage

```
<dataDir>/sessions/<sha256(sessionId)[0..24]>.json   contract + delegation ledger
<dataDir>/audit/<sessionKey>.jsonl                   append-only audit events
```

Both are plain JSON on the local disk; nothing leaves the machine. Deleting the
directory resets every contract.

## DSH 0.2.1-rc.2 mapping

The vendor adapter was written against an assumed host. `lib/dsh-compat.cjs`
maps the real payloads without editing `src/`:

| area | host reality | mapping |
| --- | --- | --- |
| message source | fixed `MessageSourceMap`, no plugin kinds | keeps `source.kind = 'stop-that-shit'`; the agent loop appends any non-`runtime-context` source verbatim (and would have replaced `runtime-context` messages, dropping the text) |
| post-execute lifecycle | `ToolExecutionResult` has no `kind` / `completed` / async flag | proven facts only: `ABORTED_BEFORE_DISPATCH` → `cancel`, a pre-execute denial recorded for the same `callId` → `deny`, else no claim (`unknown`) |
| abort code location | `result.error.info.code`, not `result.error.code` | `abortCode()` reads both |
| subagent parent | `SubagentRunInfo` / `SubagentRunEndInfo` name the child only | `parentSessionOf()`: child header `parentSession` → live `agents.get(child).session.header.parentSession` → `agents.currentInitiator()` |
| command disposal | `ctx.commands.register()` returns a service-owned disposer | captured and handed to `ctx.effect()` so unload unregisters the command |
| `/sts` injection | `createUserMessage` lives in the ESM `@deepseek-ai/dsh-llm`, which local plugins cannot resolve | dynamic `import()` when available, else an identical deep-frozen `{role:'user', source, content, id}` shape |

Synthesizing a `deny` fact for a post-execute result matters: the host runs
`tools/post-execute` even for a call it denied, so an adapter that only reacted
to `ABORTED` would leave a delegation reservation booked forever.

## Tests

```powershell
node --test test/dsh-adapter.test.cjs test/dsh-compat.test.cjs test/bridge-mount.test.cjs
```

76 tests, all passing:

- `test/dsh-adapter.test.cjs` — 52 upstream tests, unmodified.
- `test/dsh-compat.test.cjs` — 18 tests for the compatibility layer.
- `test/bridge-mount.test.cjs` — 6 tests mounting the real bridge on a minimal
  Cordis-like context: event wiring, command registration/disposal, inert guard,
  armed denial, and lifecycle events.

## Layout

```
lib/bridge.cjs            Cordis plugin: host events -> DSH adapter
lib/dsh-compat.cjs        payload mapping + /sts command
src/                      vendored upstream engine (unmodified)
test/                     upstream tests + compat/mount tests
skills/                   upstream agent skills ($stop-that-shit, stss)
locale/{zh,en}.json       bundle title/description
icon.svg                  64x64 bundle icon
cordis.patch.yml          bundle patch (id sts-bridge)
VENDOR.md                 upstream commit and the exact diffs
```

Upstream: <https://github.com/lennney/stop-that-shit> (MIT). See
[VENDOR.md](VENDOR.md) for the pinned commit and every local change.