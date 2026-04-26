#!/usr/bin/env bun
import { Command } from "commander";
import fs from "node:fs";
import { paths } from "../core/paths.ts";
import type {
	ConsoleEntry,
	NetworkEntry,
	SnapshotData,
	StatusData,
	TabInfo,
} from "../core/protocol.ts";
import {
	buildChromeArgs,
	defaultLinuxProfileDir,
	defaultPort,
	defaultWindowsProfileDir,
	launch,
	looksLikeWsl,
	stopAgentChrome,
	stopWindowsForwarder,
} from "./chrome-launcher.ts";
import { windowsHostIp } from "../core/wsl.ts";
import { getDefaultCdpUrl, persistCdpUrl } from "../core/paths.ts";
import { DaemonNotRunningError, isPidAlive, send } from "./ipc.ts";
import { emit, fail } from "./output.ts";

const program = new Command();
program
	.name("ab")
	.description(
		"agent-browser: Playwright-over-CDP browser control for agents. Attaches to a user-launched Chrome.",
	)
	.version("0.1.0")
	.option("--json", "emit raw JSON output (default: human-readable)")
	.showHelpAfterError();

function isJson(): boolean {
	return Boolean(program.opts().json);
}

async function probeCdp(cdpUrl: string, timeoutMs = 3000): Promise<{ ok: boolean; detail: string }> {
	try {
		const res = await fetch(`${cdpUrl}/json/version`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return { ok: false, detail: `http ${res.status}` };
		const body = (await res.json()) as { Browser?: string };
		return { ok: true, detail: body.Browser ?? "unknown" };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

async function waitForCdp(cdpUrl: string): Promise<void> {
	for (let i = 0; i < 30; i++) {
		const probe = await probeCdp(cdpUrl, 1000);
		if (probe.ok) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`CDP did not become reachable at ${cdpUrl}`);
}

function attachRecoveryHint(err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	const hint = looksLikeWsl()
		? "\n\nRecovery: run `ab attach --repair` to restart the isolated Chrome + WSL forwarder, or `ab chrome --url <url> && ab attach`."
		: "\n\nRecovery: run `ab chrome --url <url> && ab attach`, or retry with `ab attach --repair`.";
	return new Error(`${message}${hint}`);
}

// ---------- daemon lifecycle ----------

const daemon = program
	.command("daemon")
	.description("manage the long-running agent-browser daemon");

daemon
	.command("start")
	.description("start the daemon in the background (idempotent)")
	.action(async () => {
		try {
			// `status` auto-starts the daemon if it's not running.
			const data = (await send("status")) as StatusData;
			emit(isJson() ? "json" : "text", data, () =>
				`daemon pid=${data.daemonPid} socket=${paths.socket} attached=${data.attached}`,
			);
		} catch (err) {
			fail(err);
		}
	});

daemon
	.command("stop")
	.description("stop the daemon")
	.action(() => {
		if (!fs.existsSync(paths.pidFile)) {
			process.stderr.write("daemon not running\n");
			process.exit(0);
		}
		const pid = parseInt(fs.readFileSync(paths.pidFile, "utf8").trim(), 10);
		if (!Number.isFinite(pid)) {
			fs.unlinkSync(paths.pidFile);
			process.stderr.write("cleared stale pid file\n");
			process.exit(0);
		}
		if (!isPidAlive(pid)) {
			fs.unlinkSync(paths.pidFile);
			process.stderr.write(`daemon pid=${pid} already dead, cleared\n`);
			process.exit(0);
		}
		try {
			process.kill(pid, "SIGTERM");
			process.stderr.write(`sent SIGTERM to pid=${pid}\n`);
		} catch (err) {
			fail(err);
		}
	});

daemon
	.command("status")
	.description("show daemon + attach status")
	.option("--no-autostart", "do not auto-start the daemon if absent")
	.action(async (opts) => {
		try {
			const data = (await send("status", {}, { autostart: opts.autostart !== false })) as StatusData;
			emit(isJson() ? "json" : "text", data, () => renderStatus(data));
		} catch (err) {
			if (err instanceof DaemonNotRunningError) {
				emit(isJson() ? "json" : "text", { running: false }, () => "daemon: not running");
				return;
			}
			fail(err);
		}
	});

daemon
	.command("logs")
	.description("tail the daemon log file")
	.option("-n <lines>", "lines to print", "200")
	.action((opts) => {
		if (!fs.existsSync(paths.logFile)) {
			process.stderr.write(`no log file at ${paths.logFile}\n`);
			process.exit(0);
		}
		const lines = fs.readFileSync(paths.logFile, "utf8").split("\n");
		const n = parseInt(opts.n, 10) || 200;
		process.stdout.write(`${lines.slice(-n).join("\n")}\n`);
	});

// ---------- chrome launcher ----------

program
	.command("chrome")
	.description(
		"launch Chrome with the right flags for CDP attach (auto-detects WSL and launches Windows Chrome via powershell.exe)",
	)
	.option("--chrome <path>", "override chrome/chromium/msedge binary path")
	.option("--port <port>", "remote debugging port", String(defaultPort()))
	.option("--profile <dir>", "user data dir (defaults to platform-appropriate)")
	.option("--url <url>", "open this URL after launch")
	.option("--native", "force native launch (bypass WSL-Windows bridging)")
	.option("--print", "print the command instead of launching")
	.action((opts) => {
		try {
			const wsl = looksLikeWsl() && !opts.native;
			const mode = opts.print ? "print" : wsl ? "wsl-windows" : "native";
			const result = launch({
				chromePath: opts.chrome,
				port: parseInt(opts.port, 10),
				profileDir: opts.profile,
				startUrl: opts.url,
				mode,
			});
			if (mode !== "print") {
				// Persist so later `attach`/`doctor` default to the right URL
				// (this matters on WSL where the forwarder is on a different port).
				persistCdpUrl(result.cdpUrl);
			}
			if (mode === "print") {
				process.stdout.write(`${result.command}\n`);
				process.stderr.write(
					`\ncdp url (use for attach): ${result.cdpUrl}\nprofile: ${result.profileDir}\n`,
				);
			} else {
				process.stderr.write(
					[
						`launched chrome via ${mode}`,
						result.pid ? `pid=${result.pid}` : "",
						result.forwarderPort
							? `forwarder: Windows:${result.forwarderPort} -> localhost:${parseInt(opts.port, 10)} (pid=${result.forwarderPid ?? "?"})`
							: "",
						`cdp url: ${result.cdpUrl}`,
						`profile: ${result.profileDir}`,
					]
						.filter(Boolean)
						.join("\n") + "\n",
				);
			}
		} catch (err) {
			fail(err);
		}
	});

program
	.command("chrome-args")
	.description("print the chrome args we'd use (for embedding in other scripts)")
	.option("--port <port>", "remote debugging port", String(defaultPort()))
	.option("--profile <dir>", "user data dir")
	.option("--bind-all", "bind to 0.0.0.0 instead of 127.0.0.1")
	.action((opts) => {
		const profileDir =
			opts.profile ?? (looksLikeWsl() ? defaultWindowsProfileDir() : defaultLinuxProfileDir());
		const args = buildChromeArgs({
			port: parseInt(opts.port, 10),
			profileDir,
			bindAll: Boolean(opts.bindAll) || looksLikeWsl(),
		});
		for (const a of args) process.stdout.write(`${a}\n`);
	});

program
	.command("chrome-stop")
	.description("kill the agent-browser Chrome instance + Windows forwarder (does not touch user Chrome)")
	.action(() => {
		try {
			stopAgentChrome();
			process.stderr.write("chrome-stop: done\n");
		} catch (err) {
			fail(err);
		}
	});

program
	.command("doctor")
	.description("diagnose the environment: WSL status, Windows host IP, CDP reachability")
	.action(async () => {
		const lines: string[] = [];
		lines.push(`wsl: ${looksLikeWsl() ? "yes" : "no"}`);
		if (looksLikeWsl()) {
			const ip = windowsHostIp();
			lines.push(`windows host ip: ${ip ?? "<unknown>"}`);
		}
		const cdpUrl = getDefaultCdpUrl();
		lines.push(`cdp url: ${cdpUrl}`);
		// Probe CDP
		try {
			const res = await fetch(`${cdpUrl}/json/version`, {
				signal: AbortSignal.timeout(3000),
			});
			if (res.ok) {
				const body = (await res.json()) as { Browser?: string };
				lines.push(`cdp reachable: yes (${body.Browser ?? "unknown"})`);
			} else {
				lines.push(`cdp reachable: no (http ${res.status})`);
			}
		} catch (err) {
			lines.push(
				`cdp reachable: no (${err instanceof Error ? err.message : String(err)})`,
			);
			lines.push("");
			lines.push("fix: run `ab chrome` to launch Chrome with CDP enabled");
			if (looksLikeWsl()) {
				lines.push(
					"     (on WSL, Chrome on Windows must bind to 0.0.0.0 and the port must be allowed through Windows Firewall)",
				);
			}
		}
		// Probe daemon
		if (fs.existsSync(paths.socket)) {
			lines.push(`daemon socket: ${paths.socket}`);
		} else {
			lines.push(`daemon socket: (not running; will auto-start on first command)`);
		}
		process.stdout.write(`${lines.join("\n")}\n`);
	});

// ---------- attach / tabs ----------

program
	.command("attach")
	.description("attach the daemon to a running Chrome over CDP")
	.option("--url <url>", "CDP URL (default: http://127.0.0.1:9222 or $AGENT_BROWSER_CDP_URL)")
	.option("--repair", "restart isolated Chrome/forwarder and retry if attach fails")
	.option("--open-url <url>", "URL to open when used with --repair")
	.action(async (opts) => {
		try {
			const data = await send("attach", { debugUrl: opts.url });
			emit(isJson() ? "json" : "text", data, () => {
				const d = data as { pages: number; cdpUrl: string };
				return `attached: ${d.cdpUrl}  pages=${d.pages}`;
			});
		} catch (err) {
			if (!opts.repair) fail(attachRecoveryHint(err));
			if (opts.url) {
				fail(new Error("--repair only supports the default isolated agent-browser Chrome, not a custom --url"));
			}

			try {
				stopAgentChrome();
				const port = defaultPort();
				const mode = looksLikeWsl() ? "wsl-windows" : "native";
				const result = launch({
					port,
					startUrl: opts.openUrl,
					mode,
				});
				persistCdpUrl(result.cdpUrl);
				await waitForCdp(result.cdpUrl);
				const data = await send("attach", { debugUrl: result.cdpUrl });
				emit(isJson() ? "json" : "text", data, () => {
					const d = data as { pages: number; cdpUrl: string };
					return `repaired Chrome/forwarder\nattached: ${d.cdpUrl}  pages=${d.pages}`;
				});
			} catch (repairErr) {
				fail(new Error(`attach failed, and --repair failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`));
			}
		}
	});

program
	.command("detach")
	.description("detach from the current browser")
	.action(async () => {
		try {
			const data = await send("detach");
			emit(isJson() ? "json" : "text", data, () => "detached");
		} catch (err) {
			fail(err);
		}
	});

program
	.command("tabs")
	.description("list open tabs in the attached browser")
	.action(async () => {
		try {
			const data = (await send("tabs")) as TabInfo[];
			emit(isJson() ? "json" : "text", data, () => renderTabs(data));
		} catch (err) {
			fail(err);
		}
	});

program
	.command("tab")
	.description("switch active tab by index or URL substring")
	.option("-i, --index <n>", "tab index (from `ab tabs`)")
	.option("-u, --url <substr>", "substring of the tab URL")
	.action(async (opts) => {
		try {
			const args: Record<string, unknown> = {};
			if (opts.index !== undefined) args.index = parseInt(opts.index, 10);
			if (opts.url) args.url = opts.url;
			const data = (await send("tab", args)) as TabInfo;
			emit(isJson() ? "json" : "text", data, () =>
				`active: [${data.index}] ${data.url}  "${data.title}"`,
			);
		} catch (err) {
			fail(err);
		}
	});

// ---------- navigation ----------

program
	.command("navigate <url>")
	.alias("nav")
	.alias("goto")
	.description("navigate the active tab")
	.option(
		"--wait-until <state>",
		"load | domcontentloaded | networkidle | commit",
		"load",
	)
	.action(async (url, opts) => {
		try {
			const data = await send("navigate", { url, waitUntil: opts.waitUntil });
			emit(isJson() ? "json" : "text", data, () => {
				const d = data as { url: string; status: number | null };
				return `-> ${d.url}  [status=${d.status ?? "n/a"}]`;
			});
		} catch (err) {
			fail(err);
		}
	});

program.command("back").description("history back").action(async () => {
	try {
		const data = await send("back");
		emit(isJson() ? "json" : "text", data, () => `<- ${(data as { url: string }).url}`);
	} catch (err) {
		fail(err);
	}
});

program.command("forward").description("history forward").action(async () => {
	try {
		const data = await send("forward");
		emit(isJson() ? "json" : "text", data, () => `-> ${(data as { url: string }).url}`);
	} catch (err) {
		fail(err);
	}
});

// ---------- snapshot / actions ----------

program
	.command("snapshot")
	.alias("snap")
	.description("accessibility snapshot of active tab with stable refs (e1, e2...)")
	.action(async () => {
		try {
			const data = (await send("snapshot")) as SnapshotData;
			emit(isJson() ? "json" : "text", data, () => data.yaml);
		} catch (err) {
			fail(err);
		}
	});

program
	.command("click <ref>")
	.description("click the element with the given snapshot ref (e.g. e42)")
	.action(async (ref) => {
		try {
			const data = await send("click", { ref });
			emit(isJson() ? "json" : "text", data, () => {
				const d = data as { ref: string; url: string };
				return `clicked ${d.ref}  url=${d.url}`;
			});
		} catch (err) {
			fail(err);
		}
	});

program
	.command("type <ref> <text>")
	.description("type into an input identified by ref")
	.option("--submit", "press Enter after typing")
	.option("--no-clear", "do not clear the input first")
	.action(async (ref, text, opts) => {
		try {
			const data = await send("type", {
				ref,
				text,
				submit: Boolean(opts.submit),
				clear: opts.clear !== false,
			});
			emit(isJson() ? "json" : "text", data, () => `typed into ${ref}`);
		} catch (err) {
			fail(err);
		}
	});

program
	.command("press <key>")
	.description("press a keyboard key on the active tab (e.g. Enter, Tab, Escape)")
	.action(async (key) => {
		try {
			const data = await send("press", { key });
			emit(isJson() ? "json" : "text", data, () => `pressed ${key}`);
		} catch (err) {
			fail(err);
		}
	});

program
	.command("hover <ref>")
	.description("hover the element with the given ref")
	.action(async (ref) => {
		try {
			const data = await send("hover", { ref });
			emit(isJson() ? "json" : "text", data, () => `hovered ${ref}`);
		} catch (err) {
			fail(err);
		}
	});

program
	.command("select <ref> <values...>")
	.description("choose option(s) in a <select> (by value or label)")
	.action(async (ref, values) => {
		try {
			const data = await send("select", { ref, values });
			emit(isJson() ? "json" : "text", data, () => `selected ${values.join(", ")} in ${ref}`);
		} catch (err) {
			fail(err);
		}
	});

program
	.command("screenshot")
	.alias("shot")
	.description("screenshot active tab (default: PNG written to stdout when piped, else --out required)")
	.option("--ref <ref>", "screenshot a single element instead of the viewport")
	.option("--full-page", "capture the full scroll height")
	.option("-o, --out <path>", "write PNG to this path")
	.action(async (opts) => {
		try {
			const args: Record<string, unknown> = {
				fullPage: Boolean(opts.fullPage),
			};
			if (opts.ref) args.ref = opts.ref;
			if (opts.out) args.outPath = opts.out;
			else if (!process.stdout.isTTY) args.outPath = undefined; // base64 to stdout
			else
				throw new Error(
					"refusing to dump binary PNG to a TTY. Use --out <path> or pipe to a file.",
				);
			const data = (await send("screenshot", args)) as {
				path?: string;
				base64?: string;
				bytes: number;
			};
			if (data.path) {
				process.stderr.write(`wrote ${data.bytes} bytes to ${data.path}\n`);
			} else if (data.base64) {
				process.stdout.write(Buffer.from(data.base64, "base64"));
			}
		} catch (err) {
			fail(err);
		}
	});

program
	.command("eval <expression...>")
	.description("evaluate JS in the active page; expression is joined with spaces")
	.action(async (expression) => {
		try {
			const data = await send("eval", { expression: expression.join(" ") });
			emit(isJson() ? "json" : "text", data, () =>
				JSON.stringify((data as { result: unknown }).result, null, 2),
			);
		} catch (err) {
			fail(err);
		}
	});

program
	.command("console")
	.description("recent console messages (buffered by the daemon)")
	.option("--clear", "clear the buffer")
	.option("-n, --limit <n>", "max entries", "100")
	.option("-f, --filter <re>", "regex filter on text/type/url")
	.action(async (opts) => {
		try {
			const data = (await send("console", {
				clear: Boolean(opts.clear),
				limit: parseInt(opts.limit, 10),
				filter: opts.filter,
			})) as { entries: ConsoleEntry[]; cleared: boolean };
			emit(isJson() ? "json" : "text", data, () => {
				if (data.cleared) return "console buffer cleared";
				return renderConsole(data.entries);
			});
		} catch (err) {
			fail(err);
		}
	});

program
	.command("network")
	.alias("net")
	.description("recent network events (buffered by the daemon)")
	.option("--clear", "clear the buffer")
	.option("-n, --limit <n>", "max entries", "100")
	.option("-f, --filter <re>", "regex filter on url/method/resourceType")
	.action(async (opts) => {
		try {
			const data = (await send("network", {
				clear: Boolean(opts.clear),
				limit: parseInt(opts.limit, 10),
				filter: opts.filter,
			})) as { entries: NetworkEntry[]; cleared: boolean };
			emit(isJson() ? "json" : "text", data, () => {
				if (data.cleared) return "network buffer cleared";
				return renderNetwork(data.entries);
			});
		} catch (err) {
			fail(err);
		}
	});

program
	.command("wait <ms>")
	.description("sleep for N milliseconds (daemon-side)")
	.action(async (ms) => {
		try {
			await send("wait", { ms: parseInt(ms, 10) });
			emit(isJson() ? "json" : "text", { waitedMs: parseInt(ms, 10) }, () =>
				`waited ${ms}ms`,
			);
		} catch (err) {
			fail(err);
		}
	});

// ---------- renderers ----------

function renderStatus(s: StatusData): string {
	const lines = [
		`daemon: pid=${s.daemonPid} uptime=${Math.round(s.daemonUptimeMs / 1000)}s`,
		`attached: ${s.attached ? s.cdpUrl : "no"}`,
	];
	if (s.activeTab) {
		lines.push(`active tab: [${s.activeTab.index}] ${s.activeTab.url}`);
		if (s.activeTab.title) lines.push(`            "${s.activeTab.title}"`);
	}
	return lines.join("\n");
}

function renderTabs(tabs: TabInfo[]): string {
	if (tabs.length === 0) return "(no tabs)";
	return tabs
		.map(
			(t) =>
				`${t.active ? "*" : " "} [${t.index}] ${t.url}${t.title ? `  "${t.title}"` : ""}`,
		)
		.join("\n");
}

function renderConsole(entries: ConsoleEntry[]): string {
	if (!entries.length) return "(no console entries)";
	return entries
		.map((e) => {
			const t = new Date(e.timestamp).toISOString().slice(11, 23);
			const loc = e.url ? `  (${abbrev(e.url)}${e.lineno ? `:${e.lineno}` : ""})` : "";
			return `${t} [${e.type}] ${e.text}${loc}`;
		})
		.join("\n");
}

function renderNetwork(entries: NetworkEntry[]): string {
	if (!entries.length) return "(no network entries)";
	return entries
		.map((e) => {
			const t = new Date(e.timestamp).toISOString().slice(11, 23);
			const s = e.failure ? `FAIL(${e.failure})` : e.status ?? "pending";
			const dur = e.durationMs !== null ? `${e.durationMs}ms` : "-";
			return `${t} ${e.method.padEnd(6)} ${String(s).padEnd(8)} ${dur.padStart(6)}  ${abbrev(e.url)}`;
		})
		.join("\n");
}

function abbrev(url: string): string {
	if (url.length <= 120) return url;
	return `${url.slice(0, 60)}…${url.slice(-55)}`;
}

program.parseAsync(process.argv).catch(fail);
