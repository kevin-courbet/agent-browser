# agent-browser

`ab` is a small WSL/Windows Chrome bridge plus short alias for Vercel Labs'
[`agent-browser`](https://github.com/vercel-labs/agent-browser).

Vercel's package owns the browser automation surface: snapshots, refs, clicks,
forms, screenshots, console errors, network, and session state. This wrapper keeps
the part still missing in WSL2 setups: launching Windows Chrome with an isolated
profile and exposing its loopback-only CDP port back to WSL through a local
Windows-side forwarder.

## Install

```sh
npm install -g @kevin.courbet/agent-browser
```

From source:

```sh
git clone https://github.com/kevin-courbet/agent-browser.git
cd agent-browser
bun install
bun run cli -- doctor
```

Bun is required for the `ab` wrapper. Node is used by the upstream
`agent-browser` package.

## Quick Start

```sh
ab chrome --url https://example.com
ab snapshot
ab click @e2
ab errors --json
ab chrome-stop
```

In source checkout, use `bun run cli -- <command>` instead of `ab <command>`.

## What This Wrapper Adds

`ab chrome` does this on WSL2:

1. Launches Windows Chrome through `powershell.exe` with a dedicated profile at `%LOCALAPPDATA%\agent-browser\chrome-profile`.
2. Enables Chrome DevTools Protocol on Windows loopback, normally `127.0.0.1:9222`.
3. Starts a tiny Windows-side TCP forwarder reachable from WSL, normally `http://<windows-host-ip>:9223`.
4. Runs `agent-browser connect <cdp-url>`.

When `--url` is passed, Chrome starts directly on that URL so upstream
`agent-browser` attaches to the requested page without creating an extra blank
tab. The wrapper also closes restored/stale page targets before connecting.
Without `--url`, Chrome starts on `about:blank` so upstream never attaches to
`chrome://newtab`, which can time out on `Page.enable` under WSL forwarding.

Everything after that delegates to upstream `agent-browser` unchanged.

## Commands

Wrapper-owned commands:

| Command | Purpose |
| --- | --- |
| `ab chrome [--url <url>]` | Launch isolated Chrome, bridge CDP into WSL, connect upstream agent-browser |
| `ab chrome-stop` | Stop wrapper-launched Chrome and the Windows forwarder |
| `ab chrome-args` | Print Chrome flags used by the launcher |
| `ab doctor` | Show WSL, CDP reachability, and delegated package version |
| `ab attach [--url <cdp-url>]` | Compatibility alias for `agent-browser connect` |

Delegated examples:

```sh
ab open https://example.com
ab snapshot
ab click @e2
ab fill @e3 "test@example.com"
ab screenshot page.png
ab errors --json
ab network --json
ab close --all
```

Run `ab <command> --help` for upstream command help.

## Why the Forwarder Exists

Chrome 111+ keeps CDP bound to loopback for security. WSL2 in NAT mode cannot
reach Windows loopback directly, so `ab chrome` starts a local forwarder on the
Windows host address that WSL can reach. The forwarder binds to that host address,
not all interfaces.

CDP gives full control over the isolated browser profile. Do not expose the CDP
or forwarder ports to untrusted networks. Run `ab chrome-stop` when finished.

## Environment Variables

| Var | Default | Purpose |
| --- | --- | --- |
| `AGENT_BROWSER_CDP_URL` | auto-detected | Override CDP endpoint used by `ab attach` and `ab doctor` |
| `AGENT_BROWSER_RUNTIME_DIR` | `$TMPDIR/agent-browser` | Forwarder pid and persisted CDP URL |
| `AGENT_BROWSER_CACHE_DIR` | `~/.cache/agent-browser` | Native Chrome profile location |

## Legacy Implementation

The earlier custom Playwright-over-CDP daemon implementation is preserved in git
history and the `v0.1.0` tag. Current `main` intentionally delegates browser
automation to Vercel Labs' maintained `agent-browser` package.
