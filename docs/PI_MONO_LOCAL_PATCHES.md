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

1. **Tool-cycle abort guard** (`toolCycles` / `lastFailedTool` / `failureStreak` plus the
   `failureDiagnosticInjected` / `haltDiagnosticInjected` / `toolExecutionHalted` flags).
   Two injected user-role steering messages (`createGuardMessage`):
   - after **3 identical consecutive tool failures** → "stop repeating it";
   - when `config.maxToolCycles` is reached → "tool execution is stopped, answer the user".
   Without this a looping agent spins until the turn watchdog kills the request.

2. **Sticky fallback** (right after the assistant message is produced)
   Upstream's retry/fallback walk in `streamAssistantResponse` is *per LLM call*. This pins
   whichever fallback actually answered as `config.model` for the remainder of the **run**, so
   each tool round does not re-walk the whole failure chain against a dead primary. Deliberately
   run-scoped — the next user message starts from the configured primary again.

3. **Deferred-tool handling on the v0.86.0 transcript model**
   Upstream removed `ToolResultMessage.addedToolNames` and `ai/utils/deferred-tools.ts`, and now
   declares tools through transcript **system messages** (`SystemMessage.toolsAdded`, replayed by
   `getCurrentTools()`). The local patches keep OhMyAgent's deferred surface working:
   - `selectDeclarableTools()` — the declaration target fed to upstream `declareToolChanges()`.
     Tools flagged `deferred` are withheld until a transcript system message declares them, while
     `context.tools` (the executable set) stays complete so a direct call still resolves.
   - `ExecutedToolCallBatch.addedToolNames` + `collectAddedToolNames()` + `unlockDeferredTools()` —
     a tool result reporting `addedToolNames` is turned into a `{ role: "system", toolsAdded }`
     message (emitted and pushed into the transcript), which unlocks the tool from that transcript
     point onward and rides upstream's native mid-conversation tool-addition channel.
   - `AgentToolResult.addedToolNames` is re-added in `agent/types.ts` (upstream deleted it) because
     `src/tools/tool-search/bridge-tools.ts` still writes it.
   - `agent.ts` keeps deferred tools out of the **initial** system message
     (`tools.filter((tool) => !tool.deferred).map(toToolDeclaration)`).

4. **`failToolCallsWithSystemHalt()`**
   Once the budget is spent, executes nothing and returns an error result per call, telling the
   model to reply now. Required for the halt guard to be more than advice.

5. **v4 tool adapter error surfacing**
   `AgentToolAdapter` results carry `isError` outside the `AgentToolResult` contract. This reads
   it so patch #1's failure streak tracking sees adapter failures at all.

### `src/pi-mono/agent/agent.ts`

- `fallbackModels` (`:109`, `:222`) and `maxToolCycles` (`:111`, `:224`) options threaded onto
  the loop config.
- `ohmyagent_agentName` (`:226-227`) — human-readable agent name for logs/persistence.

### `src/pi-mono/agent/types.ts`

- `fallbackModels` / `maxToolCycles` on `AgentLoopConfig`; `0`/`undefined` = unlimited.
- `deferred?: boolean` on the tool type — consumed by patch #3 above.
- `addedToolNames?: string[]` on `AgentToolResult` — re-added after upstream v0.86.0 deleted it;
  the app's `tool_search` bridge still reports discovered tools this way.
- `stream_retry` agent event — see below.

### `src/pi-mono/ai/types.ts`

- `SimpleStreamOptions.onStreamRetry` + `StreamRetryInfo`. The retrying stream wrapper calls it
  just before sleeping the backoff delay. Provider adapters ignore the field; hosts use it to feed
  inactivity watchdogs and render retry status.

### `src/pi-mono/ai/compat.ts`

- **Custom model registry**: `registerModel()` plus patched `getModel()` / `getModels()` /
  `getProviders()` that check `pendingCustomModels` before falling back to the builtin catalog.
  This is how custom providers (e.g. MiMo/agnes) become resolvable without callers migrating to
  `createProvider`. `getModels()` also de-duplicates builtin entries whose id collides with a
  custom model (nvidia's multi-vendor catalog overlaps user-added ids). It also re-exports
  `getBuiltinProviders` (the app imports it from `@earendil-works/pi-ai`, which maps to this file).

### App-side adaptations that must survive upgrades

Not inside `src/pi-mono/`, but they exist because of the vendored contract and are easy to
regress when re-implementing:

- `src/agent/convert-to-llm.ts` — **must pass `system` messages through**. Since v0.86.0 the system
  prompt and tool declarations live in transcript system messages; filtering them out drops the
  prompt and every tool from the request.
- `src/tools/registry.ts` — `register()` normalizes a v4 `ToolDefinition` (`parametersSchema` →
  `parameters`) because v0.86.0 serializes each tool's `parameters` when building tool declarations.

## Event: `stream_retry`

Emitted when a model attempt fails and the loop is about to retry the same model
(`scope: "retry"`, via the retrying stream wrapper) or move to the next fallback
(`scope: "fallback"`). First-party consumers are the inactivity watchdog and the WebUI status
surface — if this event goes missing after an upgrade, long provider outages look like hangs.

## Upgrade procedure

1. Read the newest `docs/PI_MONO_UPGRADE_*.md` for the copy + `.ts` → `.js` import rewrite.
2. `git diff` the patched files above **before** replacing them; save the diff somewhere outside the
   worktree (the tree is normally fully committed, so back up the files themselves).
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
