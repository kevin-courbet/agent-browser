#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearPersistedCdpUrl, getDefaultCdpUrl, paths, persistCdpUrl } from "../core/paths.ts";
import { hasMirroredNetworking, parseLoopbackUrl, windowsHostIp, wslGuestIp } from "../core/wsl.ts";
import {
	buildChromeArgs,
	defaultLinuxProfileDir,
	defaultPort,
	defaultWindowsProfileDir,
	launch,
	looksLikeWsl,
	managedForwarderMatches,
	startWindowsForwarder,
	stopAgentChrome,
	windowsLoopbackListener,
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

const GLOBAL_VALUE_OPTIONS = new Set([
	"--session", "--executable-path", "--extension", "--args", "--user-agent",
	"--proxy", "--proxy-bypass", "--profile", "--session-name", "--state",
	"--headers", "--provider", "-p", "--device", "--cdp", "--color-scheme",
	"--download-path", "--max-output", "--allowed-domains", "--action-policy",
	"--confirm-actions", "--engine", "--model", "--config", "--screenshot-dir",
	"--screenshot-quality", "--screenshot-format", "--idle-timeout",
]);

const GLOBAL_BOOLEAN_OPTIONS = new Set([
	"--auto-connect", "--ignore-https-errors", "--allow-file-access", "--json",
	"--annotate", "--headed", "--content-boundaries", "--confirm-interactive",
	"--no-auto-dialog", "--debug", "--verbose", "-v", "--quiet", "-q",
]);

const EXPLICIT_BACKEND_OPTIONS = new Set([
	"--cdp", "--provider", "-p", "--auto-connect", "--engine", "--executable-path",
	"--profile", "--proxy", "--proxy-bypass", "--args", "--extension", "--user-agent",
	"--ignore-https-errors", "--allow-file-access", "--headed", "--state", "--session-name",
	"--color-scheme", "--device",
]);

const BACKEND_ENVIRONMENT_OPTIONS = [
	"AGENT_BROWSER_PROFILE", "AGENT_BROWSER_PROXY", "AGENT_BROWSER_PROXY_BYPASS",
	"AGENT_BROWSER_ARGS", "AGENT_BROWSER_EXTENSIONS", "AGENT_BROWSER_USER_AGENT",
	"AGENT_BROWSER_CDP", "AGENT_BROWSER_CDP_URL", "AGENT_BROWSER_HEADED",
	"AGENT_BROWSER_IGNORE_HTTPS_ERRORS", "AGENT_BROWSER_ALLOW_FILE_ACCESS",
	"AGENT_BROWSER_STATE", "AGENT_BROWSER_SESSION_NAME", "AGENT_BROWSER_COLOR_SCHEME",
	"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
];

const BACKEND_CONFIG_KEYS = [
	"profile", "proxy", "proxyBypass", "args", "extension", "extensions", "userAgent",
	"cdp", "headed", "ignoreHttpsErrors", "allowFileAccess", "state", "sessionName",
	"colorScheme", "device",
];

const CONNECT_VALUE_OPTIONS = new Set([
	"--session", "--allowed-domains", "--action-policy", "--confirm-actions",
	"--config", "--max-output", "--idle-timeout",
]);

const CONNECT_BOOLEAN_OPTIONS = new Set([
	"--auto-connect", "--confirm-interactive", "--no-auto-dialog",
]);

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
	const navigationIndex = delegatedCommandIndex(args);
	const needsManagedLock = looksLikeWsl() && (
		command === "chrome" || command === "chrome-stop" ||
		(navigationIndex >= 0 && !hasExplicitBackend(args))
	);
	if (needsManagedLock && process.env.AB_MANAGED_LOCK_HELD !== "1") {
		runWithManagedBrowserLock();
		return;
	}

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
		clearPersistedCdpUrl();
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

	if (looksLikeWsl() && navigationIndex >= 0 && !hasExplicitBackend(args)) {
		await handleWslNavigation(args, navigationIndex);
		return;
	}

	await runAgentBrowser(args);
}

async function handleWslNavigation(args: string[], commandIndex: number): Promise<void> {
	const urlIndex = navigationUrlIndex(args, commandIndex);
	const rawUrl = args[urlIndex];
	if (!rawUrl) throw new Error("navigation URL is missing");
	const connectArgs = findConnectArgs(args);
	const loopback = parseLoopbackUrl(rawUrl);
	const delegatedArgs = [...args];
	if (loopback) delegatedArgs[urlIndex] = loopback.url;
	const cdpUrl = getDefaultCdpUrl();
	if (!(await probeCdp(cdpUrl, 1000)).ok) {
		stopAgentChrome();
		clearPersistedCdpUrl();
		if (loopback) startLoopbackForwarder(loopback.listenAddress, loopback.port);
		await handleChrome([], connectArgs, true);
	} else {
		if (loopback) startLoopbackForwarder(loopback.listenAddress, loopback.port);
		await runAgentBrowser([...connectArgs, "connect", cdpUrl], true);
	}
	await runAgentBrowser(delegatedArgs);
}

async function handleChrome(args: string[], sessionArgs: string[] = [], prepared = false): Promise<void> {
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
	if (wsl && port === 65_535) throw new Error("WSL Chrome port must be at most 65534");
	const mode = opts.flags.has("print") ? "print" : wsl ? "wsl-windows" : "native";
	const url = opts.values.get("url");
	const loopback = wsl && url ? parseLoopbackUrl(url) : null;
	let result;
	try {
		if (wsl && mode !== "print" && !prepared) {
			stopAgentChrome();
			clearPersistedCdpUrl();
		}
		if (loopback && mode !== "print") startLoopbackForwarder(loopback.listenAddress, loopback.port);
		result = launch({
			chromePath: opts.values.get("chrome"),
			port,
			profileDir: opts.values.get("profile"),
			startUrl: url ?? "about:blank",
			mode,
		});

		if (mode === "print") {
			process.stdout.write(`${result.command}\n`);
			process.stderr.write(`\ncdp url: ${result.cdpUrl}\nprofile: ${result.profileDir}\n`);
			return;
		}

		await waitForCdp(result.cdpUrl);
		await prunePageTargets(result.cdpUrl, url);
		await runAgentBrowser([...sessionArgs, "connect", result.cdpUrl], true);
		persistCdpUrl(result.cdpUrl);
	} catch (cause) {
		clearPersistedCdpUrl();
		try {
			stopAgentChrome();
		} catch (cleanupCause) {
			throw new AggregateError([cause, cleanupCause], "browser launch and cleanup failed");
		}
		throw cause;
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

function delegatedCommandIndex(args: string[]): number {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (!arg.startsWith("-")) return ["open", "goto", "navigate"].includes(arg) ? index : -1;
		if (arg.includes("=")) continue;
		if (GLOBAL_VALUE_OPTIONS.has(arg)) {
			if (!args[index + 1]) throw new Error(`missing value for ${arg}`);
			index++;
			continue;
		}
		if (GLOBAL_BOOLEAN_OPTIONS.has(arg) && /^(?:true|false)$/.test(args[index + 1] ?? "")) index++;
	}
	return -1;
}

function navigationUrlIndex(args: string[], commandIndex: number): number {
	for (let index = commandIndex + 1; index < args.length; index++) {
		const arg = args[index]!;
		if (!arg.startsWith("-")) return index;
		if (arg.includes("=")) continue;
		if (GLOBAL_VALUE_OPTIONS.has(arg)) {
			if (!args[index + 1]) throw new Error(`missing value for ${arg}`);
			index++;
			continue;
		}
		if (GLOBAL_BOOLEAN_OPTIONS.has(arg) && /^(?:true|false)$/.test(args[index + 1] ?? "")) index++;
	}
	throw new Error("navigation URL is missing");
}

function hasExplicitBackend(args: string[]): boolean {
	const config = effectiveAgentBrowserConfig(args);
	const cli = cliBackendValues(args);
	const configuredAutoConnect = environmentBoolean("AGENT_BROWSER_AUTO_CONNECT") === true || config.autoConnect === true;
	const autoConnect = cli.autoConnect ?? configuredAutoConnect;
	const cdp = cli.cdp ?? config.cdp;
	const provider = cli.provider ?? process.env.AGENT_BROWSER_PROVIDER ?? config.provider;
	const executablePath = cli.executablePath ?? process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? config.executablePath;
	const engine = cli.engine ?? process.env.AGENT_BROWSER_ENGINE ?? config.engine ?? "chrome";
	const engineConfigured = Object.hasOwn(cli, "engine") || process.env.AGENT_BROWSER_ENGINE !== undefined || Object.hasOwn(config, "engine");
	return autoConnect === true || typeof cdp === "string" || typeof cdp === "number" ||
		typeof provider === "string" || typeof executablePath === "string" || engineConfigured || engine !== "chrome" ||
		cli.explicit === true ||
		BACKEND_ENVIRONMENT_OPTIONS.some((name) => process.env[name] !== undefined) ||
		BACKEND_CONFIG_KEYS.some((name) => Object.hasOwn(config, name));
}

function cliBackendValues(args: string[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		const [name, inlineValue] = arg.split("=", 2) as [string, string | undefined];
		if (!EXPLICIT_BACKEND_OPTIONS.has(name)) continue;
		result.explicit = true;
		if (name === "--auto-connect") {
			const value = inlineValue ?? (/^(?:true|false)$/.test(args[index + 1] ?? "") ? args[++index] : "true");
			result.autoConnect = value !== "false";
			continue;
		}
		const value = inlineValue ?? args[++index];
		if (!value) throw new Error(`missing value for ${name}`);
		if (name === "--cdp") result.cdp = value;
		if (name === "--provider" || name === "-p") result.provider = value;
		if (name === "--engine") result.engine = value;
		if (name === "--executable-path") result.executablePath = value;
	}
	return result;
}

function environmentBoolean(name: string): boolean | undefined {
	const value = process.env[name]?.toLowerCase();
	if (value === undefined) return undefined;
	return !["0", "false", "no", ""].includes(value);
}

function effectiveAgentBrowserConfig(args: string[]): Record<string, unknown> {
	const configPaths: string[] = [];
	let requiredConfig: string | null = null;
	const explicitIndex = args.findIndex((arg) => arg === "--config" || arg.startsWith("--config="));
	const environmentConfig = process.env.AGENT_BROWSER_CONFIG;
	if (explicitIndex >= 0 || environmentConfig) {
		if (explicitIndex < 0) {
			requiredConfig = path.resolve(environmentConfig!);
			configPaths.push(requiredConfig);
		} else {
		const arg = args[explicitIndex]!;
		const explicit = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[explicitIndex + 1];
		if (!explicit) throw new Error("missing value for --config");
		requiredConfig = path.resolve(explicit);
		configPaths.push(requiredConfig);
		}
	} else {
		configPaths.push(path.join(os.homedir(), ".agent-browser", "config.json"));
		configPaths.push(path.join(process.cwd(), "agent-browser.json"));
	}
	let result: Record<string, unknown> = {};
	for (const configPath of configPaths) {
		if (!fs.existsSync(configPath)) {
			if (configPath === requiredConfig) throw new Error(`agent-browser config not found: ${configPath}`);
			continue;
		}
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid agent-browser config: ${configPath}`);
		result = { ...result, ...(parsed as Record<string, unknown>) };
	}
	return result;
}

function runWithManagedBrowserLock(): void {
	fs.mkdirSync(paths.runtimeDir, { recursive: true });
	const lockPath = path.join(paths.runtimeDir, "managed-browser.flock");
	const result = spawnSync(
		"flock",
		["--wait", "10", lockPath, process.execPath, ...process.argv.slice(1)],
		{ stdio: "inherit", env: { ...process.env, AB_MANAGED_LOCK_HELD: "1" } },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`managed browser command exited with code ${result.status ?? "unknown"}`);
}

function startLoopbackForwarder(listenAddress: string, port: number): void {
	if (hasMirroredNetworking()) return;
	const guestIp = wslGuestIp();
	if (!guestIp) throw new Error("could not resolve the WSL guest address");
	const forwarder = { key: `app-${port}`, listenAddress, listenPort: port, targetAddress: guestIp, targetPort: port };
	if (managedForwarderMatches(forwarder)) return;
	const listener = windowsLoopbackListener(listenAddress, port);
	if (listener === "wsl-relay") return;
	if (listener === "conflict") throw new Error(`Windows loopback port is owned by an unrelated process: ${listenAddress}:${port}`);
	startWindowsForwarder(forwarder);
}

function findConnectArgs(args: string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		const name = arg.split("=", 1)[0]!;
		if (arg.includes("=") && (CONNECT_VALUE_OPTIONS.has(name) || CONNECT_BOOLEAN_OPTIONS.has(name))) {
			result.push(arg);
			continue;
		}
		if (CONNECT_VALUE_OPTIONS.has(arg)) {
			const value = args[index + 1];
			if (!value) throw new Error(`missing value for ${arg}`);
			result.push(arg, value);
			index++;
			continue;
		}
		if (CONNECT_BOOLEAN_OPTIONS.has(arg)) {
			result.push(arg);
			if (/^(?:true|false)$/.test(args[index + 1] ?? "")) result.push(args[++index]!);
		}
	}
	return result;
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
		looksLikeWsl() ? `wsl guest ip: ${wslGuestIp() ?? "<unknown>"}` : "",
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

type CdpTarget = {
	id?: string;
	type?: string;
	url?: string;
};

async function prunePageTargets(cdpUrl: string, preferredUrl: string | undefined): Promise<void> {
	const pages = await waitForPageTargets(cdpUrl, preferredUrl);
	if (pages.length <= 1) return;

	const keep = choosePageToKeep(pages, preferredUrl);
	await Promise.all(
		pages
			.filter((page) => page.id && page.id !== keep.id)
			.map((page) => closePageTarget(cdpUrl, page.id!)),
	);
}

async function waitForPageTargets(cdpUrl: string, preferredUrl: string | undefined): Promise<CdpTarget[]> {
	let lastPages: CdpTarget[] = [];
	for (let i = 0; i < 20; i++) {
		const pages = await listPageTargets(cdpUrl);
		lastPages = pages;
		if (preferredUrl ? pages.some((page) => page.url === preferredUrl) : pages.length > 0) {
			return pages;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return lastPages;
}

async function listPageTargets(cdpUrl: string): Promise<CdpTarget[]> {
	const res = await fetch(`${cdpUrl}/json/list`, {
		signal: AbortSignal.timeout(3000),
	});
	if (!res.ok) throw new Error(`failed to list CDP targets: HTTP ${res.status}`);
	const targets = (await res.json()) as CdpTarget[];
	return targets.filter((target) => target.type === "page" && target.id);
}

function choosePageToKeep(pages: CdpTarget[], preferredUrl: string | undefined): CdpTarget {
	if (preferredUrl) {
		return pages.find((page) => page.url === preferredUrl) ?? pages[0]!;
	}
	return pages.find((page) => page.url === "about:blank") ?? pages[0]!;
}

async function closePageTarget(cdpUrl: string, targetId: string): Promise<void> {
	const res = await fetch(`${cdpUrl}/json/close/${encodeURIComponent(targetId)}`, {
		signal: AbortSignal.timeout(3000),
	});
	if (!res.ok && res.status !== 404) {
		throw new Error(`failed to close CDP target ${targetId}: HTTP ${res.status}`);
	}
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

function runAgentBrowser(args: string[], suppressStdout = false): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(VERCEL_BIN, args, {
			stdio: suppressStdout ? ["inherit", "ignore", "inherit"] : "inherit",
		});
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
	if (!/^\d+$/.test(value)) throw new Error(`invalid port: ${value}`);
	const port = Number(value);
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new Error(`invalid port: ${value}`);
	}
	return port;
}

main().catch(fail);
