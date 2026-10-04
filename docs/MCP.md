# MCP Servers

OhMyAgent can connect to **Model Context Protocol (MCP)** servers and expose their tools to the
agent. An MCP server is a small program (or an HTTP endpoint) that publishes a list of tools over
a standard protocol — a filesystem browser, a database client, a Git helper, a SaaS API wrapper.
Adding one requires **no code change**: you describe the server once, and its tools become
available to the model like any built-in tool.

This guide is for operators. The design rationale lives in `MyDocs/MCP_INTEGRATION_DESIGN.md`.

## What is supported

| Transport | Configuration | Notes |
|---|---|---|
| stdio | `command` + `args` (+ `env`, `cwd`) | A child process started and stopped by the gateway. Most npm/Python servers use this. |
| streamable HTTP | `url` (+ `headers`, optional `oauth`) | A remote endpoint. This is the only HTTP flavour supported. |
| HTTP + SSE | — | **Not supported.** A legacy `sse` server is rejected, and the config loader fails that server with a clear error rather than connecting to something it cannot talk to. |

`config.yaml` is the **single source of truth** for MCP servers. There is no second config file
merged at startup: the WebUI settings page, the `mcp.json` import command and manual edits all end
up in the same `mcp:` section.

Everything is inert while that section is absent — no process is spawned, no connection is
attempted, no MCP tool exists. Upgrading an installation that never configures MCP changes nothing.

## Installing a server

**Settings → MCP** (the last entry in the *integration* group, below *Computer Use*).

### From a preset

Open the preset list to see the built-in catalogue (filesystem, Git, fetch, GitHub, memory,
Sequential Thinking and time). Picking one prefills the install form; you only fill in what the
server needs — usually nothing, sometimes an API key. Presets marked with a required environment
variable show a hint next to each field, and the GitHub preset requires a personal access token
(`GITHUB_PERSONAL_ACCESS_TOKEN`) before it will start.

### Manually

*Install* opens the same form in a blank state. Fill in:

| Field | Notes |
|---|---|
| Name | Used in tool names (`mcp__<name>__<tool>`) and in `config.yaml`. Letters, digits, `-` and `_` only. `-` and `_` are the same character for this purpose, so `my-server` and `my_server` are the same server. |
| Transport | *stdio* (command + arguments) or *HTTP* (URL + headers). |
| Command / arguments | The executable is a **single binary** (`npx`, `uvx`, `node`, `/usr/bin/foo`), never a shell string. Arguments are edited as a list, one per row. |
| Environment | Extra environment variables for the child process. Values accept `${ENV}` interpolation. |
| URL / headers | For HTTP servers. `Authorization: Bearer ${TOKEN}` works as you would expect. |
| Exposure | How the server's tools reach the model — see below. Default: `deferred`. |
| Timeout | Per-server request timeout in seconds; overrides `mcp.request_timeout_sec`. |
| Description | One line, shown in the settings UI and used for prompt ranking. Write it — a good description makes `tool_search` find the server. |

**Test connection** starts the server once and reports its name, version, protocol version and tool
list without saving anything. Packages are **not** downloaded at install time: `npx -y …` fetches
the package on first connect, so be patient the very first time and watch the log pane if it fails.
Saving a server writes the entry, hot-reloads the config, and connects it in the background.

**Enable / disable** is immediate: disabling closes the connection and unregisters the tools, so
the model no longer sees them (they come back on the next turn after re-enabling). **Uninstall**
does the same and additionally removes the config entry, after showing which skills reference the
server and whether `mcp.allow_servers` / `deny_servers` mention it.

## Exposure: direct, deferred, hidden

MCP servers can contribute dozens of tools. Loading all of them into every request costs context
and degrades tool selection, so each server (or each individual tool) chooses how it is exposed:

| Exposure | Behaviour | Use it when |
|---|---|---|
| `deferred` | Registered but hidden. The model discovers the tool with `tool_search` and can then call it. **Default.** | Almost always. |
| `direct` | In the model's tool list on every turn. | A tool the agent needs constantly, usually for a server with only a couple of tools. |
| `hidden` | **Not registered at all** — completely unreachable, including from skills. | A tool you want to keep out of the gateway entirely while leaving it in the config. To keep a tool callable from a skill but out of the model's list, use `deferred`. |
| `codemode` | Accepted for compatibility with upstream configs; treated exactly as `deferred`. | You copied a config that used it. |

Per-tool overrides live in `tool_exposure`, keyed by tool name, with a trailing `*` wildcard:

```yaml
mcp:
  servers:
    filesystem:
      exposure: deferred
      tool_exposure:
        read_file: direct
        write_*: hidden
```

`direct` tools are always callable. `deferred` tools become callable once `tool_search` has matched
them: the search runs over every registered MCP tool, so a good `description` and the server's own
tool descriptions are what make them findable. When a server publishes only a few tools, the agent
may see them directly even at `deferred` — the tool surface is only thinned down when the total
count is large enough for it to matter.

## Approvals

MCP tools go through the normal approval pipeline. The server's `annotations` decide the default
risk; MCP annotations are *hints* from the server and are treated as untrusted, so they can only
ever relax the default when they explicitly declare a tool read-only, and `destructiveHint` always
wins over `readOnlyHint`:

| Annotation | Risk | Behaviour |
|---|---|---|
| `readOnlyHint: true` | low | Auto-approved (unless a policy rule or skill demands confirmation). |
| neither hint | medium | First call asks for approval, like any unknown tool. |
| `destructiveHint: true` | high | Always asks; the global `approval_timeout_action: allow` does not apply to high-risk calls. |

Approval rules and per-skill policies apply as usual, so you can pre-approve a trusted server's
read-only tools while still confirming the ones that write.

## OAuth (HTTP servers)

Some remote servers require OAuth. The 401 does not break the server: it is reported as
`auth_required` in **Settings → MCP**, and its tools stay registered while it waits for a login.

1. Open the server in the detail drawer and click **Log in** (or the badge on its card).
2. The gateway starts a local callback listener and shows the authorization URL. It opens in your
   browser; if the machine is headless — a Termux/Android install, a container, or a desktop you
   are reaching over SSH — copy the URL and open it wherever you have a browser. You can also
   prefill `oauth.client_id` / `oauth.client_secret` in `config.yaml` if the provider does not
   support dynamic client registration.
3. After you consent, the provider redirects to `http://localhost:<callback_port>/…`. On a headless
   machine that redirect fails in the browser — that is expected. Copy the full URL from the
   address bar and paste it into the login dialog. The gateway extracts the code, exchanges it, and
   reconnects the server.
4. `insufficient_scope` is handled by an **upgrade**: already-granted scopes are kept and only the
   missing ones are requested again.

Tokens are stored per `(server name, server URL)` in the `mcp_oauth_credentials` SQLite table and
are refreshed automatically. Uninstalling a server offers to delete its stored credentials; if you
keep them, a later re-install of the same name/URL can skip the login. `oauth.callback_port`
defaults to `8765`, and the registered client name defaults to `OhMyAgent` (some providers only
accept known client names).

> **Known limitation:** `client_secret`, `access_token` and `refresh_token` are stored in plain
> text in the local SQLite database, the same way provider API keys are stored in `config.yaml`.
> Anyone with read access to `data/app.db` can read them. Keep the database on a machine you trust.

## Resource tools

Servers that publish *resources* (as opposed to tools) get three read-only tools, registered only
when at least one connected server actually provides resources:

| Tool | Parameters | Returns |
|---|---|---|
| `mcp__resources__list` | `{ server?, cursor? }` | JSON `{ server?, resources, nextCursor? }` |
| `mcp__resources__list_templates` | `{ server?, cursor? }` | The server's URI templates |
| `mcp__resources__read` | `{ server, uri }` | Text for text resources, an image for image resources, and a file path (spilled to `data/offload/`) for anything else |

They are auto-approved, follow the profile visibility rules like every other MCP tool, and can be
turned off with `mcp.deny_servers: ['resources']` — `resources` is a reserved pseudo-server name
and is not subject to `mcp.allow_servers`.

## Importing an existing `mcp.json`

Already have an MCP config from another client? Convert it once:

```bash
pnpm mcp:import                      # reads ./mcp.json
pnpm mcp:import path/to/mcp.json     # or point at any file
pnpm mcp:import --dry-run            # print the plan and the resulting YAML, write nothing
```

The standard `{ "mcpServers": { … } }` shape is accepted. `command`/`args`/`env`/`cwd` become a
stdio server, `url`/`headers` an HTTP one, and `type: streamable-http` is written back as `http`.
`type: sse` is refused with an explanation. Unknown keys (other clients' metadata such as
`disabled`, `autoApprove`) are listed on the imported server and dropped.

This is a **one-shot import, not a second configuration source**: nothing reads `mcp.json` at
startup. A server whose name already exists in `config.yaml` is never overwritten — the command
prints a key-by-key diff and exits with code 1 without writing anything. Re-running an import that
is already applied reports the servers as unchanged and does not touch the file.

## Troubleshooting

**`npx: command not found` / the server exits immediately with code 127**
The stdio server is launched with the gateway's own environment, so `npx` (or `uvx`, `python`) must
be on the `PATH` the gateway sees. On Termux or in a container that often is not the case; use an
absolute path in `command` (for example `/data/data/com.termux/files/usr/bin/npx`) or install the
package globally and point `command` at the binary.

**The server never connects**
Open the server's card: the state badge shows `connecting`, `error` or `connected`, and the detail
drawer has a log pane with the tail of the server's log — the child process's stderr plus the
server's own `notifications/message` entries — which is where most startup failures explain
themselves (missing credentials, an npm error, a bad `cwd`). The same tail is available as
`GET /api/mcp/servers/<name>/logs?lines=200` (default 200 lines, capped at 2000); before the log
file exists the endpoint falls back to the in-memory stderr tail, which is capped at 64 KiB, and
`?lines` applies on that path too. The file lives at `<logDir>/mcp-<server>.log`, where `logDir` is
`$OHMYAGENT_LOG_DIR`, else `$OHMYAGENT_HOME/logs`, else `~/.ohmyagent/logs`, and it rotates at
5 MB to a single `mcp-<server>.log.1` generation — `tail -f` it if you prefer a terminal.
Note that a failing server never blocks the gateway: it stays in
`error` and is retried with exponential backoff on the next call, so a misconfigured server shows
up as "the tool is missing", not as a failed startup.

**A 401 / `auth_required`**
The server wants OAuth — see the OAuth section above. If you configured static credentials instead,
check that `headers.Authorization` resolves: `${TOKEN}` comes from the gateway's environment
(`.env`) and resolves to an empty string when the variable is unset, which produces exactly this
symptom with no other error.

**The tools disappear from the model's view**
Check, in order: the server is enabled; its exposure is not `hidden`; `mcp.allow_servers` /
`deny_servers` do not exclude it; and the agent's profile is not `restricted` — MCP tools are never
visible in a `restricted` profile. Tools are registered at agent-creation time, so a change applies
from the next turn, not to a reply already in flight.

**Large tool output**
Results above `mcp.max_output_bytes` (default 20 KiB) are written to `data/offload/` and the model
receives the head and tail plus the file path. Nothing is lost — the agent can read the file back.
