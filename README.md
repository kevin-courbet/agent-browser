# agent-browser

CLI-driven browser control for coding agents. Playwright over CDP, attaches to
a real Chrome so agents can snapshot, click, type, eval, screenshot, and read
console + network.

Built to replace BrowserMCP, whose Chrome-extension architecture has a
long-standing click-timeout bug (see upstream issues [#85][b85], [#115][b115],
[#26][b26]) rooted in MV3 service-worker lifecycle. Playwright sidesteps the
whole extension model by speaking CDP directly.

[b85]: https://github.com/browsermcp/mcp/issues/85
[b115]: https://github.com/browsermcp/mcp/issues/115
[b26]: https://github.com/browsermcp/mcp/issues/26

## What you get

- **snapshot** — ARIA/role-aware DOM walk tagged with stable refs (`e1`, `e2`, …)
- **click / type / press / hover / select** — ref-based, real event dispatch
- **screenshot** — viewport, full-page, or per-element PNG
- **navigate / back / forward / tabs / tab** — multi-tab control
- **console / network** — ring-buffered in the daemon so nothing is missed between CLI calls
- **eval** — arbitrary JS in the page
- **doctor** — diagnose environment (WSL, host IP, CDP reachability)

## Architecture

```
 ┌──────────────┐   JSON-line over     ┌─────────────────┐    Playwright
 │   `ab` CLI   │  /tmp/...sock  ◀──▶ │     daemon      │ ──  CDP  ──▶ Chrome
 │    (Bun)     │                      │ (Node + strip-  │
 └──────────────┘                      │  types)         │
                                       └─────────────────┘
```

- **CLI under Bun**: fast startup (~50 ms per command).
- **Daemon under Node**: Playwright's CDP client hangs under Bun (WebSocket
  upgrade deadlocks in `connectOverCDP`). Node 22 strips TS types natively
  (`--experimental-strip-types`), so the daemon runs `.ts` directly without a
  build step.
- **Daemon persists** across CLI calls so console + network buffers accumulate
  and snapshot refs stay live.

## Install

```sh
npm install -g @kevin-courbet/agent-browser

# Or from source:
git clone https://github.com/kevin-courbet/agent-browser.git
cd agent-browser
bun install
```

Node 22+ is required for the daemon. The CLI auto-spawns the daemon on first
use.

The CLI runs on Bun for fast startup. The daemon runs on Node because
Playwright CDP attach currently times out under Bun in the WSL-to-Windows Chrome
path.

## Usage

### WSL2 → Windows Chrome (the common case in this setup)

```sh
# Launch Chrome on the Windows host (via powershell.exe) + a Windows-side TCP
# forwarder bound to the WSL-reachable host address.
bun src/cli/index.ts chrome --url https://example.com

# Sanity check
bun src/cli/index.ts doctor
# → wsl: yes
# → windows host ip: 172.29.160.1
# → cdp url: http://172.29.160.1:9223
# → cdp reachable: yes (Chrome/…)

# Drive the browser
bun src/cli/index.ts attach
bun src/cli/index.ts snapshot
bun src/cli/index.ts click e42
bun src/cli/index.ts screenshot --out /tmp/page.png

# Shut it down cleanly (closes Chrome + forwarder, leaves your daily Chrome alone)
bun src/cli/index.ts chrome-stop
```

#### Why the forwarder?

Chrome 111+ silently ignores `--remote-debugging-address=0.0.0.0` for
security reasons — CDP binds to `127.0.0.1` only. WSL2 in NAT mode can't
reach Windows loopback. `ab chrome` solves this by:

1. Launching Chrome on Windows, CDP on `127.0.0.1:9222`.
2. Starting a tiny in-process C# TCP forwarder (via PowerShell `Add-Type`)
   that listens on the Windows host address reachable from WSL and relays to
   `127.0.0.1:9222`.
3. Returning the CDP URL `http://<wsl-gateway-ip>:9223` for the daemon.

Everything is isolated to the dedicated profile at
`%LOCALAPPDATA%\agent-browser\chrome-profile` — your real Chrome session is
untouched.

CDP gives full control over the isolated browser profile. Do not expose the CDP
or forwarder ports to untrusted networks; run `ab chrome-stop` when done.

### Native (Linux / macOS)

```sh
bun src/cli/index.ts chrome --url https://example.com
bun src/cli/index.ts attach
bun src/cli/index.ts snapshot
```

### Attach to a Chrome you launched yourself

```sh
# If you already have Chrome running with `--remote-debugging-port=9222`:
bun src/cli/index.ts attach --url http://127.0.0.1:9222

# Or set once for the shell:
export AGENT_BROWSER_CDP_URL=http://127.0.0.1:9222
bun src/cli/index.ts attach
```

## Command reference

Run `bun src/cli/index.ts <command> --help` for every command. Summary:

| Command | Purpose |
| --- | --- |
| `daemon start \| stop \| status \| logs` | Daemon lifecycle |
| `chrome` | Launch Chrome with CDP enabled (auto-detects WSL) |
| `chrome-stop` | Stop the agent-browser Chrome + forwarder |
| `chrome-args` | Print the exact Chrome flags |
| `doctor` | Diagnose env + CDP reachability |
| `attach [--url]` | Connect the daemon to a running Chrome |
| `detach` | Disconnect |
| `tabs` / `tab -i N \| -u substr` | List / switch tabs |
| `open <url>` | Open a fresh observed tab |
| `navigate <url>` / `back` / `forward` | History |
| `snapshot` | ARIA tree with refs |
| `click <ref>` | Click element by ref |
| `type <ref> <text> [--submit]` | Fill an input |
| `press <key>` | Keyboard press |
| `hover <ref>` | Hover |
| `select <ref> <val…>` | `<select>` option |
| `screenshot [--ref R] [--full-page] [-o path]` | PNG capture |
| `eval <expr…>` | Run JS in page |
| `console [--clear] [-n N] [-f re]` | Buffered console |
| `network [--clear] [-n N] [-f re]` | Buffered requests |
| `wait <ms>` | Sleep |

Add `--json` to any command for machine-readable output.

## Integrating into agent harnesses

The whole surface is just the `ab` binary and stdout. No harness-specific
glue required — any agent that can run shell commands can drive it.

- **Coding-agent CLIs**: invoke `ab <cmd>` through the shell tool. Redirect PNGs
  to a file and then read them.
- **LangGraph / your own loop**: shell out to `ab --json <cmd>`, parse the
  JSON response.

Example agent prompt fragment:

```
Browser control is available via `ab`:
- Run `ab doctor` to check state.
- `ab snapshot` returns an ARIA tree with `[ref=eN]` — use those refs for click/type.
- After any navigation, re-snapshot before the next action (refs are per-snapshot).
- `ab console --filter error` shows errors, `ab network --filter api` shows API calls.
```

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `AGENT_BROWSER_CDP_URL` | auto-detected | Override the CDP endpoint |
| `AGENT_BROWSER_RUNTIME_DIR` | `$TMPDIR/agent-browser` | Socket, pid, log |
| `AGENT_BROWSER_CACHE_DIR` | `~/.cache/agent-browser` | Chrome profile (native) |
| `AGENT_BROWSER_NODE` | `node` | Node binary for the daemon |

## Known limitations

- Refs are regenerated on every snapshot. Always snapshot before acting —
  `e42` in a past snapshot may be a different element now.
- The daemon does not yet wire a `requestresponse` network tap for bodies.
  It captures method/URL/status/timing/failure only.
- `chrome --url` auto-attaches first and opens the URL through the daemon so
  initial console, network, and pageerror events are buffered.
- No file upload helper yet (`setInputFiles`). Use `eval` with a `DataTransfer`
  workaround for now.
- Screenshot to stdout writes raw PNG bytes — pipe or `--out` only.
