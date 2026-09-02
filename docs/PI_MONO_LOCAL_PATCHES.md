# pi-mono: First-Party Patches

`src/pi-mono/` is a **vendored copy** of upstream pi-mono, not an npm dependency. Upgrades
replace whole files from the upstream tarball, which **silently deletes every local edit in
them**. This file is the inventory of those edits.

Read this before every upgrade, and verify each patch is still present afterwards.

Current embedded version: see `src/pi-mono/VERSION` (do not trust a version quoted in prose).

## Why these exist

OhMyAgent ships a gateway on constrained devices (Termux/Android). Upstream pi-mono assumes an
interactive CLI with one reliable model and no hard turn deadline. The patches below add the
production guards a gateway needs: bounded tool loops, model failover that survives a whole run,
custom provider registration, and progress signals that feed inactivity watchdogs.

## Inventory

Every patch is marked in-source with the string `OhMyAgent`. To regenerate this list:

```bash
grep -rn "OhMyAgent" src/pi-mono --include="*.ts"
```

As of the last audit, exactly **5 files** carry load-bearing edits.

### `src/pi-mono/agent/agent-loop.ts` — highest risk

Five distinct patches in the hot loop:

1. **Tool-cycle abort guard** (`:170-179`, `:272-317`)
   Counters `toolCycles` / `lastFailedTool` / `failureStreak` plus the
   `failureDiagnosticInjected` / `haltDiagnosticInjected` / `toolExecutionHalted` flags.
   Two injected user-role steering messages (`createGuardMessage`):
   - after **3 identical consecutive tool failures** → "stop repeating it";
   - when `config.maxToolCycles` is reached → "tool execution is stopped, answer the user".
   Without this a looping agent spins until the turn watchdog kills the request.

2. **Sticky fallback** (`:232-247`)
   Upstream's retry/fallback walk in `streamAssistantResponse` is *per LLM call*. This pins
   whichever fallback actually answered as `config.model` for the remainder of the **run**, so
   each tool round does not re-walk the whole failure chain against a dead primary. Deliberately
   run-scoped — the next user message starts from the configured primary again.

3. **Deferred-tool filter** (`:372`, `:535-552`)
   `compactToolsForPrompt()` drops tools flagged `deferred` from the prompt to keep token cost
   down, **except** those already unlocked in the transcript via a tool result's
   `addedToolNames` (`tool_search` / `tool_call` hits). The unlock is transcript-scoped so the
   model can call an already-discovered tool directly.

4. **`failToolCallsWithSystemHalt()`** (`:601-631`)
   Once the budget is spent, executes nothing and returns an error result per call, telling the
   model to reply now. Required for the halt guard to be more than advice.

5. **v4 tool adapter error surfacing** (`:925-929`)
   `AgentToolAdapter` results carry `isError` outside the `AgentToolResult` contract. This reads
   it so patch #1's failure streak tracking sees adapter failures at all.

### `src/pi-mono/agent/agent.ts`

- `fallbackModels` (`:109`, `:222`) and `maxToolCycles` (`:111`, `:224`) options threaded onto
  the loop config.
- `ohmyagent_agentName` (`:226-227`) — human-readable agent name for logs/persistence.

### `src/pi-mono/agent/types.ts`

- `fallbackModels` / `maxToolCycles` on `AgentLoopConfig` (`:151-157`); `0`/`undefined` = unlimited.
- `deferred?: boolean` on the tool type (`:420`) — consumed by patch #3 above.
- `stream_retry` agent event (`:453-463`) — see below.

### `src/pi-mono/ai/types.ts`

- `SimpleStreamOptions.onStreamRetry` (`:322-328`) + `StreamRetryInfo` (`:331+`). The retrying
  stream wrapper calls it just before sleeping the backoff delay. Provider adapters ignore the
  field; hosts use it to feed inactivity watchdogs and render retry status.

### `src/pi-mono/ai/compat.ts`

- **Custom model registry** (`:65-108`): `registerModel()` plus patched `getModel()` /
  `getModels()` / `getProviders()` that check `pendingCustomModels` before falling back to the
  builtin catalog. This is how custom providers (e.g. MiMo) become resolvable without callers
  migrating to `createProvider`. `getModels()` also de-duplicates builtin entries whose id
  collides with a custom model (nvidia's multi-vendor catalog overlaps user-added ids).

## Event: `stream_retry`

Emitted when a model attempt fails and the loop is about to retry the same model
(`scope: "retry"`, via the retrying stream wrapper) or move to the next fallback
(`scope: "fallback"`). First-party consumers are the inactivity watchdog and the WebUI status
surface — if this event goes missing after an upgrade, long provider outages look like hangs.

## Upgrade procedure

1. Read the newest `docs/PI_MONO_UPGRADE_*.md` for the copy + `.ts` → `.js` import rewrite.
2. `git diff` the 5 files above **before** replacing them; save the diff somewhere outside the
   worktree.
3. After the wholesale copy, re-apply each patch, then confirm:
   ```bash
   grep -rc "OhMyAgent" src/pi-mono --include="*.ts" | grep -v ':0$'
   ```
   — the file list must match the inventory above.
4. Build, then run the loop-behaviour tests specifically:
   ```bash
   pnpm build && npx vitest run tests/agent
   ```
5. Record anything that had to be re-applied in the new `docs/PI_MONO_UPGRADE_*.md`.

## Do not

- Do not "clean up", reformat, or refactor anything under `src/pi-mono/`. Divergence from
  upstream makes the next upgrade diff unreadable, and the vendored tree is replaced wholesale
  anyway — refactoring here is thrown away.
- Do not fix a first-party bug by patching `src/pi-mono/` if the fix belongs upstream; report it
  upstream and note it here until the release lands.
