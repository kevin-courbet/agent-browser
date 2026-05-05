#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultCdpUrl, persistCdpUrl } from "../core/paths.ts";
import { windowsHostIp } from "../core/wsl.ts";
import {
	buildChromeArgs,
	defaultLinuxProfileDir,
	defaultPort,
	defaultWindowsProfileDir,
	launch,
	looksLikeWsl,
	stopAgentChrome,
} from "./chrome-launcher.ts";
import { fail } from "./output.ts";

const require = createRequire(import.meta.url);
const VERCEL_BIN = path.join(
	path.dirname(require.resolve("agent-browser/package.json")),
	"bin",
	"agent-browser.js",
);

type ParsedOptions = {
	values: Map<string, string>;
	flags: Set<string>;
	positionals: string[];
};

const HELP = `ab: WSL Chrome bridge for Vercel agent-browser

Usage:
  ab chrome [--url <url>] [--port <port>] [--chrome <path>] [--profile <dir>] [--native] [--print]
  ab chrome-stop
  ab chrome-args [--port <port>] [--profile <dir>] [--bind-all]
  ab doctor
  ab <agent-browser command...>

Examples:
  ab chrome --url https://example.com
  ab snapshot
  ab click @e2
  ab errors --json
`;

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(HELP);
		return;
	}

	if (command === "--version" || command === "-V") {
		await runAgentBrowser(["--version"]);
		return;
	}

	if (command === "chrome") {
		await handleChrome(args.slice(1));
		return;
	}

	if (command === "chrome-stop") {
		stopAgentChrome();
		process.stderr.write("chrome-stop: done\n");
		return;
	}

	if (command === "chrome-args") {
		handleChromeArgs(args.slice(1));
		return;
	}

	if (command === "doctor") {
		await handleDoctor();
		return;
	}

	if (command === "attach") {
		await handleAttach(args.slice(1));
		return;
	}

	await runAgentBrowser(args);
}

async function handleChrome(args: string[]): Promise<void> {
	const opts = parseOptions(args, new Set(["chrome", "port", "profile", "url"]), new Set(["native", "print"]));
	if (opts.flags.has("help")) {
		process.stdout.write("Usage: ab chrome [--url <url>] [--port <port>] [--chrome <path>] [--profile <dir>] [--native] [--print]\n");
		return;
	}
	if (opts.positionals.length > 0) {
		throw new Error(`unexpected chrome argument: ${opts.positionals.join(" ")}`);
	}

	const port = parsePort(opts.values.get("port") ?? String(defaultPort()));
	const wsl = looksLikeWsl() && !opts.flags.has("native");
	const mode = opts.flags.has("print") ? "print" : wsl ? "wsl-windows" : "native";
	const result = launch({
		chromePath: opts.values.get("chrome"),
		port,
		profileDir: opts.values.get("profile"),
		mode,
	});

	if (mode === "print") {
		process.stdout.write(`${result.command}\n`);
		process.stderr.write(`\ncdp url: ${result.cdpUrl}\nprofile: ${result.profileDir}\n`);
		return;
	}

	persistCdpUrl(result.cdpUrl);
	await waitForCdp(result.cdpUrl);
	await runAgentBrowser(["connect", result.cdpUrl]);

	const url = opts.values.get("url");
	if (url) {
		await runAgentBrowser(["open", url]);
	}

	process.stderr.write(
		[
			`launched chrome via ${mode}`,
			result.pid ? `pid=${result.pid}` : "",
			result.forwarderPort
				? `forwarder: Windows:${result.forwarderPort} -> localhost:${port} (pid=${result.forwarderPid ?? "?"})`
				: "",
			`cdp url: ${result.cdpUrl}`,
			`profile: ${result.profileDir}`,
			url ? `opened: ${url}` : "",
		]
			.filter(Boolean)
			.join("\n") + "\n",
	);
}

async function handleAttach(args: string[]): Promise<void> {
	const opts = parseOptions(args, new Set(["url"]), new Set());
	const url = opts.values.get("url") ?? opts.positionals[0] ?? getDefaultCdpUrl();
	await runAgentBrowser(["connect", url]);
}

function handleChromeArgs(args: string[]): void {
	const opts = parseOptions(args, new Set(["port", "profile"]), new Set(["bind-all"]));
	const port = parsePort(opts.values.get("port") ?? String(defaultPort()));
	const profileDir = opts.values.get("profile") ?? (looksLikeWsl() ? defaultWindowsProfileDir() : defaultLinuxProfileDir());
	const chromeArgs = buildChromeArgs({
		port,
		profileDir,
		bindAll: opts.flags.has("bind-all"),
	});
	for (const arg of chromeArgs) process.stdout.write(`${arg}\n`);
}

async function handleDoctor(): Promise<void> {
	const cdpUrl = getDefaultCdpUrl();
	const probe = await probeCdp(cdpUrl, 3000);
	const lines = [
		`wsl: ${looksLikeWsl() ? "yes" : "no"}`,
		looksLikeWsl() ? `windows host ip: ${windowsHostIp() ?? "<unknown>"}` : "",
		`cdp url: ${cdpUrl}`,
		`cdp reachable: ${probe.ok ? `yes (${probe.detail})` : `no (${probe.detail})`}`,
		`delegate: agent-browser@${await agentBrowserVersion()}`,
	];
	process.stdout.write(`${lines.filter(Boolean).join("\n")}\n`);
}

async function waitForCdp(cdpUrl: string): Promise<void> {
	for (let i = 0; i < 30; i++) {
		const probe = await probeCdp(cdpUrl, 1000);
		if (probe.ok) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`CDP did not become reachable at ${cdpUrl}`);
}

async function probeCdp(cdpUrl: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
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

async function agentBrowserVersion(): Promise<string> {
	const packageJson = require("agent-browser/package.json") as { version?: string };
	return packageJson.version ?? "unknown";
}

function runAgentBrowser(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(VERCEL_BIN, args, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`agent-browser exited with code ${code ?? "unknown"}`));
		});
	});
}

function parseOptions(args: string[], valueNames: Set<string>, flagNames: Set<string>): ParsedOptions {
	const values = new Map<string, string>();
	const flags = new Set<string>();
	const positionals: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}

		const [rawName, inlineValue] = arg.slice(2).split("=", 2) as [string, string | undefined];
		if (rawName === "help") {
			flags.add("help");
			continue;
		}
		if (flagNames.has(rawName)) {
			flags.add(rawName);
			continue;
		}
		if (!valueNames.has(rawName)) {
			throw new Error(`unknown option: --${rawName}`);
		}
		const value = inlineValue ?? args[++i];
		if (!value) throw new Error(`missing value for --${rawName}`);
		values.set(rawName, value);
	}

	return { values, flags, positionals };
}

function parsePort(value: string): number {
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new Error(`invalid port: ${value}`);
	}
	return port;
}

main().catch(fail);
