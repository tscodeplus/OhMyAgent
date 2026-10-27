# Deploying OhMyAgent on Android (Termux)

Production runbook for running the gateway on a phone. Everything below was
checked against this repository; anything that needs hands-on Android hardware
to confirm is marked **⚠ unverified** with a short note on how to check it.

OhMyAgent in production is **one Node process**: Fastify serves the HTTP API, the
WebSocket channel, and the WebUI from the same origin on `0.0.0.0:9191`
(`src/app/bootstrap.ts`). There is no separate UI server and no background
worker process — the cron scheduler and the memory maintenance jobs run inside
that process.

---

## 1. Environments: dev box vs. production phone

|          | Dev                                     | Prod                                    |
| -------- | --------------------------------------- | --------------------------------------- |
| Machine  | Windows workstation                     | Android phone (Termux)                  |
| Purpose  | Development, experiments, test memories | Your actual assistant                   |
| Database | `data/app.db` on the PC                 | `~/.ohmyagent/data/app.db` on the phone |

**Production data is not migrated from the dev machine.** The phone starts with
an empty database, which the server creates on first start:

- The dev database is full of test memories, superseded rows and experiment
  residue; importing it would corrupt recall quality rather than preserve it.
- The vault projection (`pnpm graph:export`) and all memory state are derived
  from whatever database is live, so a fresh prod database simply starts with an
  empty vault — nothing needs copying.
- What _is_ copied by hand is **configuration, not knowledge**: `config.yaml`
  and `.env` (provider keys, channel credentials, `WEBUI_TOKEN`).

Everything the agent knows in production is authored in production — through
chat, the WebUI, or the IM channels. Do not upload a dev `app.db`.

---

## 2. Prerequisites

Install Termux from F-Droid or the GitHub releases page — **⚠ unverified**: the
Play Store build is reported as deprecated by the Termux project itself, and its
packages lag behind; confirm the Play Store build can still install `nodejs`
before relying on it.

```bash
pkg update && pkg upgrade -y
pkg install git nodejs-lts python clang make termux-api termux-services -y
node -v        # must be >= 20
```

- `python`, `clang`, `make` are needed to build the native dependencies
  (`better-sqlite3`, `sqlite-vec`; `sharp` for image handling). `install.sh`
  installs the same set for Termux.
- `termux-services` provides `sv` / `SVDIR`, which the service installer depends
  on (`src/cli/commands/service.ts` checks for `sv` first).
- `termux-api` provides `termux-wake-lock`, which the generated runit script
  calls.
- **⚠ unverified:** that prebuilt binaries exist for `android-arm64` for every
  native dependency. If `pnpm install` falls back to compiling, the toolchain
  above is what makes that succeed; a bare Termux install will fail there.

---

## 3. Install and build

```bash
# One command (checks prerequisites, builds, offers to install the service):
curl -fsSL https://raw.githubusercontent.com/tscodeplus/OhMyAgent/main/install.sh | bash
```

or by hand, in the directory that will contain the install
(`install.sh` uses `$HOME/OhMyAgent` by default and honours
`OHMYAGENT_INSTALL_DIR`):

```bash
git clone https://github.com/tscodeplus/OhMyAgent.git ~/OhMyAgent
cd ~/OhMyAgent

pnpm install --prefer-offline      # never npm: the workspace and lockfile are pnpm's

cp config.yaml.example config.yaml
cp .env.example .env               # then set WEBUI_TOKEN and your provider key

pnpm build                         # tsc -> dist/src/index.js
pnpm build:ui                      # ui/ -> ui/dist (needed for the WebUI)
```

- `pnpm build` is mandatory: the service run script executes
  `dist/src/index.js`, and `ohmyagent start` refuses to run without it.
- `pnpm build:ui` produces `ui/dist`, which is what the server serves in
  production. Without it the server starts and logs
  `WebUI static files … no index.html` instead of showing a blank page with no
  explanation.
- Termux-native build failures (`gyp`, `Python not found`, `clang: error`) mean
  the toolchain packages from §2 are missing.

---

## 4. Configure

`.env` (secrets, never committed):

```bash
WEBUI_TOKEN=<a long random string>     # stable WebUI login token
PI_AI_API_KEY=<provider key>           # or the key your config.yaml references
# OHMYAGENT_PORT=9191                  # only if 9191 is taken
```

`config.yaml` follows `config.yaml.example`. Relevant to deployment:

- `provider`, channel credentials, and `database.path`
  (default `~/.ohmyagent/data/app.db`; the `DATABASE_PATH` env var wins).
- The database file, its `-wal`/`-shm` companions and the directory are created
  on first start, with `0600` permissions where the filesystem supports it.
- `WEBUI_TOKEN` is the _only_ authentication factor for the WebUI/API. If it is
  not set, the server generates a random token per run and prints it to stderr
  — fine for a smoke test, useless for a phone you want to keep using.

**WebUI serving mode** (`src/app/webui/setup-vite.ts`): static files are served
when `NODE_ENV=production` **or** when `WEBUI_STATIC_ROOT` is set; otherwise, if
`ui/src` exists, the server starts Vite middleware with HMR. The runit script
that `service install` generates does **not** set `NODE_ENV`, so a supervised
phone install would serve the UI through Vite middleware (dev dependencies,
source files) instead of `ui/dist`. Add one line to
`$PREFIX/var/service/ohmyagent/run` after installing the service, and re-add it
if you ever re-run `ohmyagent service install`:

```bash
export NODE_ENV=production
# or: export WEBUI_STATIC_ROOT="$HOME/OhMyAgent/ui/dist"
```

The WebUI is always mounted at `/webui/` on the same origin as the API.

---

## 5. Run it as a supervised service

```bash
# from the install directory, using the CLI wrapper install.sh created
# (~/.local/bin/ohmyagent, or /usr/local/bin/ohmyagent on desktop platforms)
ohmyagent service install      # writes and enables the runit service
ohmyagent service uninstall    # stops and removes it
```

The CLI exposes exactly two service verbs: `install` and `uninstall`
(`src/cli/index.ts`). Day-to-day control is runit's:

```bash
SVDIR=$PREFIX/var/service sv status ohmyagent
SVDIR=$PREFIX/var/service sv up ohmyagent        # start
SVDIR=$PREFIX/var/service sv down ohmyagent      # stop
SVDIR=$PREFIX/var/service sv restart ohmyagent
```

`sv` comes from `termux-services`; in a Termux login shell `SVDIR` is usually
already exported, so plain `sv status ohmyagent` also works. If `sv: command not
found`, `pkg install termux-services` and reopen the session.

What `service install` writes (`src/cli/commands/service.ts`):

- `$PREFIX/var/service/ohmyagent/run` — a small bash script that
  `cd`s to the project directory, runs `termux-wake-lock`, and
  `exec`s the current Node binary on `dist/src/index.js`.
- `$PREFIX/var/service/ohmyagent/log/run` — `svlogd -tt <project>/data/logs/`,
  so logs land in `data/logs/current` with timestamped rotations.
- then it runs `SVDIR=$PREFIX/var/service sv up ohmyagent`.

`ohmyagent start|stop|restart|status` also work: `start` detects the installed
service and delegates to `sv up`, and `status` probes
`http://127.0.0.1:$PORT/api/health` (`src/cli/utils.ts`).

### Autostart after reboot

Android has no init system, so **⚠ unverified — must be confirmed on the
device**: whether the runit supervision tree comes back after a reboot. The
service directory survives; what may not restart is `runsvdir`. Practical
options, in order of reliability:

1. Install the **Termux:Boot** app, then create `~/.termux/boot/ohmyagent.sh`
   containing `export SVDIR=$PREFIX/var/service; sv up ohmyagent` (Termux:Boot
   runs scripts in that directory at boot).
2. Open Termux once after boot — `termux-services` starts `runsvdir` from its
   login-shell profile hook.

Whichever you use, run the reboot test in §9 before trusting it.

---

## 6. Keep-alive on Android

The run script calls `termux-wake-lock`, which holds a wake lock so the CPU and
Wi-Fi are not suspended while the service is wanted. That is necessary but not
sufficient:

- Android Settings → Apps → Termux → Battery → **unrestricted** (disable
  battery optimisation). OEM skins (Xiaomi/MIUI, Huawei, Samsung, OnePlus) have
  additional "protect app"/"allow background activity" switches — enable them
  for both Termux and Termux:Boot.
- Keep the phone charging; aggressive thermal/battery managers are the most
  common cause of random kills.
- **Be honest about the failure mode:** Android may still kill the whole Termux
  app under memory pressure or when an OEM power manager decides it is idle.
  What runit buys you is (a) restart-on-crash of the _Node process_ while the
  supervision tree is alive, and (b) a recorded exit in `data/logs/current`.
  Nothing inside the app can survive the app being killed. Recover by opening
  Termux and running `sv status ohmyagent` / `sv up ohmyagent`; the database is
  crash-safe (WAL), so an abrupt kill does not corrupt it.

---

## 7. Remote access: get a stable origin _before_ installing the PWA

The WebUI ships a PWA manifest and a service worker:

- `ui/public/manifest.webmanifest` declares `"id": "/webui/"`,
  `"start_url": "/webui/"`, `"scope": "/webui/"` — absolute paths.
- `ui/src/main.tsx` registers `/webui/sw.js` in production builds.

Both are **origin-scoped**. An installed PWA is bound to the exact origin
(scheme + host + port) it was installed from: changing hostname, adding HTTPS, or
moving from `:9191` to `:443` makes the installed icon point at an origin that no
longer serves the app — the icon still opens, but the install is invalidated
(storage, service worker, and the "installed" state belong to the old origin).
Choose the final origin first, then install.

Do **not** use the phone's LAN IP as the PWA origin: DHCP/mDNS addresses change,
and the origin would change with them.

### Option A — Tailscale (tailnet-only, no domain needed)

1. Install the Tailscale app on the phone and on the clients; sign both into the
   same tailnet, enable **MagicDNS** so the phone gets a stable name
   (`https://<device>.<tailnet>.ts.net`).
2. Point the origin at the local server behind Tailscale's HTTPS front:
   `tailscale serve --bg --https=443 http://127.0.0.1:9191`
   → WebUI at `https://<device>.<tailnet>.ts.net/webui/`.
   **⚠ unverified:** `tailscale serve` requires the `tailscaled` CLI. The
   Android Tailscale app gives you the tailnet IP/MagicDNS name but may not
   expose `serve`; check on the phone with `tailscale serve status`. If the
   command is unavailable, either run `tailscaled` inside Termux (unsupported by
   the app) or use Option B.
3. Bind/keep the server on `127.0.0.1:9191` and let Tailscale terminate TLS, or
   keep the default `0.0.0.0` bind if you also want LAN access.

Why this is the low-friction option: the tailnet name is stable across network
changes, TLS is real (PWA install needs a secure context — `http://<phone-ip>` is
not one), and nothing is exposed to the public internet.

### Option B — Cloudflare Tunnel (custom domain)

Use this when you own a domain and want `https://oma.example.com/webui/`:

```bash
pkg install cloudflared            # ⚠ unverified: package name/availability
cloudflared tunnel login
cloudflared tunnel create ohmyagent
cloudflared tunnel route dns ohmyagent oma.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: ohmyagent
credentials-file: /data/data/com.termux/files/home/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: oma.example.com
    service: http://127.0.0.1:9191
  - service: http_status:404
```

Run it under the same supervision tree (`$PREFIX/var/service/cloudflared/run`,
`exec cloudflared tunnel run ohmyagent`) so it restarts with the agent. Consider
putting Cloudflare Access in front of it as a second authentication factor — the
WebUI token alone is a single shared secret exposed to the internet.

Note that with a tunnel you can keep the agent bound to `127.0.0.1` only
(`OHMYAGENT_BIND_ADDRESS=127.0.0.1`), which is a smaller attack surface than
`0.0.0.0`.

---

## 8. Backups

What matters:

| Path                | Why                                                           |
| ------------------- | ------------------------------------------------------------- |
| `data/app.db`       | All memory, sessions, approvals. The only irreplaceable file. |
| `config.yaml`       | Providers, channels, tool policy.                             |
| `.env`              | Secrets (`WEBUI_TOKEN`, API keys).                            |
| `vault/` (optional) | Generated projection — regenerate with `pnpm graph:export`.   |

Use SQLite's `VACUUM INTO`, not `cp`: it takes a consistent snapshot of a live
database (WAL included) and leaves a single compact file.

`~/bin/oma-backup.sh`:

```bash
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$HOME/OhMyAgent"
DEST="$HOME/oma-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST/$STAMP"

# Consistent DB snapshot. `sqlite3` comes from `pkg install sqlite`.
sqlite3 "$ROOT/data/app.db" "VACUUM INTO '$DEST/$STAMP/app.db'"

cp "$ROOT/config.yaml" "$DEST/$STAMP/" 2>/dev/null || true
cp "$ROOT/.env" "$DEST/$STAMP/" 2>/dev/null || true
chmod 600 "$DEST/$STAMP"/*

# Keep 7 snapshots, delete older ones.
ls -1dt "$DEST"/*/ | tail -n +8 | xargs -r rm -rf

# Optional: copy off-device (Tailscale/SSH to the PC).
# scp -P 8022 "$DEST/$STAMP/app.db" user@host:backups/
```

Schedule it:

```bash
pkg install cronie termux-services -y
sv-enable crond
crontab -e
```

```cron
30 3 * * * /data/data/com.termux/files/home/bin/oma-backup.sh >> /data/data/com.termux/files/home/OhMyAgent/data/logs/backup.log 2>&1
```

- Use absolute paths inside `crontab` — it does not expand `~` or `$HOME`, and
  its `PATH` may not include `$PREFIX/bin`.
- **⚠ unverified:** whether `crond` under Termux keeps firing while the device
  is dozing. If your phone sleeps deeply, check the log timestamps; the Android
  alternative is `termux-job-scheduler` (Termux API), which integrates with
  Android's job scheduler but has its own minimum-period constraints.
- Verify a snapshot really restored (§9) — an untested backup is a guess.

### Restore

```bash
cd ~/OhMyAgent
SVDIR=$PREFIX/var/service sv down ohmyagent

mv data/app.db data/app.db.broken
rm -f data/app.db-wal data/app.db-shm
cp ~/oma-backups/<stamp>/app.db data/app.db
chmod 600 data/app.db

SVDIR=$PREFIX/var/service sv up ohmyagent
curl -fsS http://127.0.0.1:9191/api/health
```

Keep `data/app.db.broken` until you have confirmed the restored data looks right
(WebUI memory page, or `sqlite3 data/app.db 'select count(*) from memories'`).

---

## 9. Verification checklist

Run these in order after the first deploy, after every upgrade, and after a
reboot.

1. **Process and health**

   ```bash
   SVDIR=$PREFIX/var/service sv status ohmyagent     # run: ohmyagent: (pid …)
   curl -fsS http://127.0.0.1:9191/api/health        # {"ok":true,"version":"…","timestamp":"…"}
   ```

   `/api/health` is auth-exempt by design (`src/app/webui-auth.ts`); if it hangs,
   the process is not listening. If it answers but the UI does not, the problem is
   the WebUI build or the token.

2. **WebUI login**

   Open the chosen origin (e.g. `https://<device>.<tailnet>.ts.net/webui/`), enter
   `WEBUI_TOKEN`, and confirm the chat view loads and a memo/health request
   succeeds. A `401` means the token does not match `.env`; an empty page with a
   `WebUI static files` error in the log means `pnpm build:ui` was not run.

3. **PWA install**

   On the phone's browser, "Add to Home screen". Then verify: the icon opens
   **standalone** (no browser chrome), the URL stays on the origin you chose, and
   the service worker is active (DevTools → Application → Service Workers, or
   just confirm the app opens after a restart while the server is down — the shell
   is cached, the data is not).

4. **One IM channel round-trip**

   Send a message to the configured channel (Telegram/Feishu/WeChat) and get a
   reply. This exercises provider credentials, channel webhooks _and_ the DB
   writer. Then confirm the memory landed:

   ```bash
   sqlite3 ~/OhMyAgent/data/app.db 'select count(*) from memories;'
   ```

5. **Survives a reboot**

   Reboot the phone, wait for boot to finish, then `sv status ohmyagent` and
   `curl -fsS http://127.0.0.1:9191/api/health` **without opening Termux first**
   if you rely on Termux:Boot. If it is not running, the boot hook is missing
   (§5) — the service itself is fine.

6. **Logs and disk**

   `tail -n 50 ~/OhMyAgent/data/logs/current` shows the startup banner without
   repeated restarts, and `df -h $HOME` has room for the growing database plus
   snapshots.

7. **Optional: vault projection**

   ```bash
   cd ~/OhMyAgent && pnpm graph:export --out ~/vault
   ```

   Read-only against `data/app.db`; the second run must report `0 written`
   (idempotent). Notes under `~/vault/manual/**` are yours and are never touched.

---

## 10. What this runbook could not verify from a Windows dev box

Everything below was written from the repository and general Android/Termux
knowledge, not from a working phone:

- Package availability and versions in Termux (`nodejs-lts` ≥ 20, `cloudflared`,
  `sqlite`, `cronie`) and whether all native dependencies have `android-arm64`
  prebuilds or must compile on-device.
- Whether `tailscale serve --bg --https=443` is available on the Android
  Tailscale build, and whether MagicDNS names resolve correctly from the phone.
- Termux:Boot / `runsvdir` behaviour after a real reboot, including whether the
  runit supervision tree starts without opening Termux.
- `crond` (or `termux-job-scheduler`) surviving Android doze, and the real
  frequency of background kills under the OEM power manager.
- The Play Store Termux build's current package state.
- Cloudflare Tunnel CLI availability in Termux and the exact
  `cloudflared` service unit.
- Actual memory/CPU footprint on a specific phone model.
