import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REMOTE_DEBUGGING_PORT, paths } from "../core/paths.ts";
import { isWsl, windowsHostIp, wslToWindowsPath } from "../core/wsl.ts";

const LINUX_CHROME_CANDIDATES = [
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/snap/bin/chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const WINDOWS_CHROME_CANDIDATES = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files\\Chromium\\Application\\chrome.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const BROWSER_STATE_PATH = path.join(paths.runtimeDir, "windows-browser.json");
const FORWARDER_STATE_DIR = path.join(paths.runtimeDir, "windows-forwarders");

type BrowserOwnership = {
	ownerId: string;
	executablePath: string;
	profileDir: string;
};

type LaunchingBrowserState = BrowserOwnership & { status: "launching" };

type RunningBrowserState = BrowserOwnership & {
	status: "running";
	pid: number;
	creationTime: string;
};

type BrowserState = LaunchingBrowserState | RunningBrowserState;

type ForwarderOwnership = {
	instanceId: string;
	scriptPath: string;
	listenAddress: string;
	listenPort: number;
	targetAddress: string;
	targetPort: number;
};

type LaunchingForwarderState = ForwarderOwnership & { status: "launching" };

type RunningForwarderState = ForwarderOwnership & {
	status: "running";
	pid: number;
};

type ForwarderState = LaunchingForwarderState | RunningForwarderState;

export type LaunchMode = "native" | "wsl-windows" | "print";

export interface LaunchOptions {
	chromePath?: string | undefined;
	port: number;
	startUrl?: string | undefined;
	profileDir?: string | undefined;
	mode: LaunchMode;
	bindAll?: boolean | undefined;
	forwarderPort?: number | undefined;
}

export interface LaunchResult {
	mode: LaunchMode;
	pid?: number | undefined;
	command: string;
	cdpUrl: string;
	profileDir: string;
	forwarderPort?: number | undefined;
	forwarderPid?: number | undefined;
}

function psQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function powershell(script: string, timeout = 10_000): string {
	return execFileSync(
		"powershell.exe",
		["-NoProfile", "-Command", `Set-Location -LiteralPath $env:WINDIR; ${script}`],
		{ encoding: "utf8", timeout },
	).trim();
}

function windowsArgument(value: string): string {
	if (!/[\s"]/u.test(value)) return value;
	let quoted = '"';
	let backslashes = 0;
	for (const character of value) {
		if (character === "\\") {
			backslashes++;
			continue;
		}
		if (character === '"') {
			quoted += "\\".repeat(backslashes * 2 + 1) + '"';
			backslashes = 0;
			continue;
		}
		quoted += "\\".repeat(backslashes) + character;
		backslashes = 0;
	}
	return quoted + "\\".repeat(backslashes * 2) + '"';
}

function windowsLocalAppData(): string {
	const result = powershell("[Environment]::GetFolderPath('LocalApplicationData')");
	if (!result) throw new Error("Windows LocalApplicationData is empty");
	return result;
}

function validateWindowsProfile(profileDir: string, create: boolean): void {
	if (!/^[A-Za-z]:\\/.test(profileDir) || profileDir.startsWith("\\\\")) {
		throw new Error(`Windows profile must be an absolute local drive path: ${profileDir}`);
	}
	if (!create) return;
	const profile = psQuote(profileDir);
	const probeName = psQuote(`.ab-write-probe-${randomUUID()}`);
	powershell(
		`New-Item -ItemType Directory -Force -Path ${profile} | Out-Null; if (-not (Test-Path -LiteralPath ${profile} -PathType Container)) { throw 'profile is not a directory' }; $probe = Join-Path ${profile} ${probeName}; try { $stream = [System.IO.File]::Open($probe, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None); $stream.Dispose() } finally { if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force -ErrorAction Stop } }`,
	);
}

function windowsFileExists(candidate: string): boolean {
	return powershell(`Test-Path -LiteralPath ${psQuote(candidate)} -PathType Leaf`).toLowerCase() === "true";
}

export function resolveLinuxChromePath(hint?: string): string {
	if (hint) {
		if (!fs.existsSync(hint)) throw new Error(`chrome binary not found at ${hint}`);
		return hint;
	}
	for (const candidate of LINUX_CHROME_CANDIDATES) {
		if (fs.existsSync(candidate)) return candidate;
	}
	throw new Error(`could not find Chrome/Chromium. Pass --chrome <path> or install one of:\n  ${LINUX_CHROME_CANDIDATES.join("\n  ")}`);
}

export function resolveWindowsChromePath(hint?: string): string {
	if (hint) {
		if (!windowsFileExists(hint)) throw new Error(`Chrome binary not found at ${hint}`);
		return hint;
	}
	const candidates = [
		`${windowsLocalAppData()}\\Google\\Chrome\\Application\\chrome.exe`,
		...WINDOWS_CHROME_CANDIDATES,
	];
	for (const candidate of candidates) {
		if (windowsFileExists(candidate)) return candidate;
	}
	throw new Error(`could not find Chrome, Chromium, or Edge on Windows. Pass --chrome <path>; checked:\n  ${candidates.join("\n  ")}`);
}

export function buildChromeArgs(opts: {
	port: number;
	profileDir: string;
	startUrl?: string | undefined;
	bindAll?: boolean | undefined;
}): string[] {
	const args = [
		`--remote-debugging-port=${opts.port}`,
		`--user-data-dir=${opts.profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate,InsecureDownloadWarnings",
		"--remote-allow-origins=*",
		"--host-resolver-rules=MAP localhost 127.0.0.1",
	];
	if (opts.bindAll) args.push("--remote-debugging-address=0.0.0.0");
	if (opts.startUrl) args.push(opts.startUrl);
	return args;
}

export function defaultLinuxProfileDir(): string {
	return paths.profileDir;
}

export function defaultWindowsProfileDir(): string {
	return `${windowsLocalAppData()}\\agent-browser\\chrome-profile`;
}

export function windowsLoopbackListener(address: string, port: number): "absent" | "wsl-relay" | "conflict" {
	validatePort(port, "Windows listen port");
	const result = powershell(
		`$listeners = @(Get-NetTCPConnection -State Listen -LocalAddress ${psQuote(address)} -LocalPort ${port} -ErrorAction SilentlyContinue); if ($listeners.Count -eq 0) { 'absent'; exit 0 }; $owners = @($listeners | ForEach-Object { Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.OwningProcess)\" -ErrorAction SilentlyContinue }); if ($owners.Count -gt 0 -and @($owners | Where-Object { $_.Name -notin @('wslrelay.exe','wslhost.exe') }).Count -eq 0) { 'wsl-relay' } else { 'conflict' }`,
	).toLowerCase();
	if (result === "absent" || result === "wsl-relay" || result === "conflict") return result;
	throw new Error(`could not identify Windows loopback listener at ${address}:${port}`);
}

export function managedForwarderMatches(opts: {
	key: string;
	listenAddress: string;
	listenPort: number;
	targetAddress: string;
	targetPort: number;
}): boolean {
	const statePath = forwarderStatePath(opts.key);
	if (!fs.existsSync(statePath)) return false;
	const state = readForwarderState(statePath);
	if (state.status !== "running" || state.listenAddress !== opts.listenAddress ||
		state.listenPort !== opts.listenPort || state.targetAddress !== opts.targetAddress ||
		state.targetPort !== opts.targetPort) return false;
	const pid = state.pid;
	return powershell(
		`$process = Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue; if ($null -ne $process -and $process.CommandLine -like ${psQuote(`*${state.instanceId}*`)} -and $process.CommandLine -like ${psQuote(`*${state.scriptPath}*`)}) { 'true' } else { 'false' }`,
	).toLowerCase() === "true";
}

export function launch(opts: LaunchOptions): LaunchResult {
	const bindAll = opts.bindAll ?? false;
	if (opts.mode === "wsl-windows") {
		validatePort(opts.port, "Chrome port");
		const forwarderPort = opts.forwarderPort ?? opts.port + 1;
		validatePort(forwarderPort, "CDP forwarder port");
		const profileDir = opts.profileDir ?? defaultWindowsProfileDir();
		validateWindowsProfile(profileDir, true);
		const chromePath = resolveWindowsChromePath(opts.chromePath);
		assertWindowsProfileAvailable(chromePath, profileDir);
		const ownerId = randomUUID();
		const launchingState = { status: "launching", ownerId, executablePath: chromePath, profileDir } satisfies LaunchingBrowserState;
		writeJson(BROWSER_STATE_PATH, launchingState);
		const args = [...buildChromeArgs({ port: opts.port, profileDir, startUrl: opts.startUrl }), `--ab-owner-id=${ownerId}`];
		const argumentList = args.map(windowsArgument).join(" ");
		const psCmd = `$process = Start-Process -FilePath ${psQuote(chromePath)} -WorkingDirectory (Split-Path -Parent ${psQuote(chromePath)}) -ArgumentList ${psQuote(argumentList)} -PassThru -ErrorAction Stop; for ($attempt = 0; $attempt -lt 20; $attempt++) { $cim = Get-CimInstance Win32_Process -Filter \"ProcessId=$($process.Id)\" -ErrorAction SilentlyContinue; if ($null -ne $cim) { break }; Start-Sleep -Milliseconds 50 }; if ($null -eq $cim) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue; throw 'Chrome process metadata is unavailable' }; [pscustomobject]@{ pid = $process.Id; creationTime = $cim.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress`;
		let launched: { pid?: unknown; creationTime?: unknown };
		try {
			launched = JSON.parse(powershell(psCmd)) as { pid?: unknown; creationTime?: unknown };
		} catch (cause) {
			stopLaunchingBrowser(launchingState);
			throw cause;
		}
		let pid: number;
		try {
			pid = requirePid(launched.pid, "Chrome");
			if (typeof launched.creationTime !== "string" || !launched.creationTime) throw new Error("Chrome launch did not return a creation timestamp");
		} catch (cause) {
			stopLaunchingBrowser(launchingState);
			throw cause;
		}
		const browserState = { ...launchingState, status: "running", pid, creationTime: launched.creationTime } satisfies RunningBrowserState;
		try {
			writeJson(BROWSER_STATE_PATH, browserState);
		} catch (cause) {
			stopManagedBrowser(browserState);
			throw cause;
		}

		const host = windowsHostIp();
		if (!host) throw new Error("could not resolve the Windows host address");
		const forwarder = startWindowsForwarder({
			key: "cdp",
			listenAddress: host,
			listenPort: forwarderPort,
			targetAddress: "127.0.0.1",
			targetPort: opts.port,
		});
		const command = `powershell.exe -NoProfile -Command ${psQuote(psCmd)}`;
		return { mode: opts.mode, pid, command, cdpUrl: `http://${host}:${forwarderPort}`, profileDir, forwarderPort, forwarderPid: forwarder.pid };
	}

	if (opts.mode === "print" && isWsl()) {
		const profileDir = opts.profileDir ?? defaultWindowsProfileDir();
		validateWindowsProfile(profileDir, false);
		const chromePath = resolveWindowsChromePath(opts.chromePath);
		const args = buildChromeArgs({ port: opts.port, profileDir, startUrl: opts.startUrl });
		const argumentList = args.map(windowsArgument).join(" ");
		const psCmd = `Start-Process -FilePath ${psQuote(chromePath)} -WorkingDirectory (Split-Path -Parent ${psQuote(chromePath)}) -ArgumentList ${psQuote(argumentList)}`;
		return { mode: opts.mode, command: `powershell.exe -NoProfile -Command ${shellQuote(psCmd)}`, cdpUrl: `http://127.0.0.1:${opts.port}`, profileDir };
	}

	const profileDir = opts.profileDir ?? defaultLinuxProfileDir();
	fs.mkdirSync(profileDir, { recursive: true });
	const chromePath = resolveLinuxChromePath(opts.chromePath);
	const args = buildChromeArgs({ port: opts.port, profileDir, startUrl: opts.startUrl, bindAll });
	if (opts.mode === "print") {
		return { mode: opts.mode, command: `${shellQuote(chromePath)} ${args.map(shellQuote).join(" ")}`, cdpUrl: `http://127.0.0.1:${opts.port}`, profileDir };
	}
	const child = spawn(chromePath, args, { stdio: "ignore", detached: true });
	child.unref();
	return { mode: opts.mode, pid: child.pid, command: `${shellQuote(chromePath)} ${args.map(shellQuote).join(" ")}`, cdpUrl: `http://127.0.0.1:${opts.port}`, profileDir };
}

export function startWindowsForwarder(opts: {
	key: string;
	listenAddress: string;
	listenPort: number;
	targetAddress: string;
	targetPort: number;
}): RunningForwarderState {
	validatePort(opts.listenPort, "forwarder listen port");
	validatePort(opts.targetPort, "forwarder target port");
	stopWindowsForwarder(opts.key);
	const scriptWsl = fileURLToPath(new URL("./windows-forwarder.ps1", import.meta.url));
	const scriptPath = wslToWindowsPath(scriptWsl);
	if (!scriptPath) throw new Error(`could not translate forwarder script path to Windows: ${scriptWsl}`);
	fs.mkdirSync(FORWARDER_STATE_DIR, { recursive: true });
	const statePath = forwarderStatePath(opts.key);
	const pidPath = `${statePath}.pid`;
	const pidPathWin = wslToWindowsPath(pidPath);
	if (!pidPathWin) throw new Error(`could not translate forwarder pid path to Windows: ${pidPath}`);
	fs.rmSync(pidPath, { force: true });
	const instanceId = randomUUID();
	const launchingState: LaunchingForwarderState = { status: "launching", instanceId, scriptPath, listenAddress: opts.listenAddress, listenPort: opts.listenPort, targetAddress: opts.targetAddress, targetPort: opts.targetPort };
	writeJson(statePath, launchingState);
	const childArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ListenAddress", opts.listenAddress, "-ListenPort", String(opts.listenPort), "-TargetAddress", opts.targetAddress, "-TargetPort", String(opts.targetPort), "-PidFile", pidPathWin, "-InstanceId", instanceId];
	const argumentList = childArgs.map(windowsArgument).join(" ");
	const starter = JSON.parse(powershell(`$process = Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -WorkingDirectory $env:WINDIR -ArgumentList ${psQuote(argumentList)} -PassThru -ErrorAction Stop; [pscustomobject]@{ pid = $process.Id } | ConvertTo-Json -Compress`)) as { pid?: unknown };
	const starterPid = requirePid(starter.pid, "forwarder starter");
	let pid: number | null = null;
	for (let attempt = 0; attempt < 30; attempt++) {
		try {
			pid = requirePid(fs.readFileSync(pidPath, "utf8").trim(), "forwarder");
			break;
		} catch {}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
	}
	fs.rmSync(pidPath, { force: true });
	if (!pid) {
		powershell(`Stop-Process -Id ${starterPid} -Force -ErrorAction SilentlyContinue`);
		throw new Error(`forwarder did not start on ${opts.listenAddress}:${opts.listenPort}`);
	}
	const state: RunningForwarderState = { ...launchingState, status: "running", pid };
	writeJson(statePath, state);
	try {
		powershell(
			`for ($attempt = 0; $attempt -lt 30; $attempt++) { $process = Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue; if ($null -eq $process) { throw 'forwarder exited before listening' }; $listener = Get-NetTCPConnection -State Listen -LocalPort ${opts.listenPort} -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq ${pid} -and $_.LocalAddress -eq ${psQuote(opts.listenAddress)} }; if ($null -ne $listener) { exit 0 }; Start-Sleep -Milliseconds 100 }; throw 'forwarder did not start listening'`,
			5000,
		);
	} catch (cause) {
		stopWindowsForwarder(opts.key);
		throw new Error(`could not bind forwarder at ${opts.listenAddress}:${opts.listenPort}`, { cause });
	}
	return state;
}

export function stopWindowsForwarder(key: string): void {
	const statePath = forwarderStatePath(key);
	if (!fs.existsSync(statePath)) return;
	const state = readForwarderState(statePath);
	if (state.status === "launching") {
		stopLaunchingForwarder(state);
		fs.rmSync(statePath);
		return;
	}
	const pid = state.pid;
	const script = [
		`$process = Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue`,
		`if ($null -eq $process) { exit 0 }`,
		`if ($process.CommandLine -notlike ${psQuote(`*${state.instanceId}*`)} -or $process.CommandLine -notlike ${psQuote(`*${state.scriptPath}*`)}) { throw 'forwarder PID identity mismatch' }`,
		`Stop-Process -Id ${pid} -Force -ErrorAction Stop`,
		`for ($attempt = 0; $attempt -lt 30; $attempt++) { if ($null -eq (Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 100 }`,
		`if (Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue) { throw 'forwarder did not stop' }`,
	].join("; ");
	powershell(script);
	fs.rmSync(statePath);
}

export function stopAgentChrome(): void {
	const errors: unknown[] = [];
	try {
		stopAllWindowsForwarders();
	} catch (cause) {
		errors.push(cause);
	}
	if (looksLikeWsl() && fs.existsSync(BROWSER_STATE_PATH)) {
		try {
			const state = readBrowserState();
			if (state.status === "launching") stopLaunchingBrowser(state);
			else stopManagedBrowser(state);
			fs.rmSync(BROWSER_STATE_PATH);
		} catch (cause) {
			errors.push(cause);
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "could not stop all managed browser resources");
}

function stopManagedBrowser(state: RunningBrowserState): void {
	const pid = state.pid;
	const creationTime = state.creationTime;
	const profilePattern = windowsProfilePattern(state.profileDir);
	const script = [
		`$root = Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue`,
		`if ($null -eq $root) { $unowned = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${psQuote(state.executablePath)} -and $_.CommandLine -match ${psQuote(profilePattern)} }); if ($unowned.Count -gt 0) { throw 'stale browser metadata matches an unowned process' }; exit 0 }`,
		`if ($null -ne $root -and ($root.CreationDate.ToUniversalTime().ToString('o') -ne ${psQuote(creationTime)} -or $root.ExecutablePath -ne ${psQuote(state.executablePath)} -or $root.CommandLine -notmatch ${psQuote(profilePattern)})) { throw 'browser PID identity mismatch' }`,
		`$managed = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${psQuote(state.executablePath)} -and $_.CommandLine -match ${psQuote(profilePattern)} })`,
		`if ($managed.Count -gt 0) { Stop-Process -Id $managed.ProcessId -Force -ErrorAction Stop }`,
		`for ($attempt = 0; $attempt -lt 30; $attempt++) { $remaining = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${psQuote(state.executablePath)} -and $_.CommandLine -match ${psQuote(profilePattern)} }); if ($remaining.Count -eq 0) { break }; Start-Sleep -Milliseconds 100 }`,
		`if ($remaining.Count -gt 0) { throw \"managed browser did not stop: $($remaining.ProcessId -join ', ')\" }`,
	].join("; ");
	powershell(script, 15_000);
}

function stopLaunchingBrowser(state: LaunchingBrowserState): void {
	powershell(
		`$managed = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${psQuote(state.executablePath)} -and $_.CommandLine -like ${psQuote(`*--ab-owner-id=${state.ownerId}*`)} }); if ($managed.Count -gt 0) { Stop-Process -Id $managed.ProcessId -Force -ErrorAction Stop }`,
		15_000,
	);
}

function stopLaunchingForwarder(state: ForwarderState): void {
	const script = `$managed = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*powershell.exe' -and $_.CommandLine -like ${psQuote(`*${state.instanceId}*`)} -and $_.CommandLine -like ${psQuote(`*${state.scriptPath}*`)} }); if ($managed.Count -gt 0) { Stop-Process -Id $managed.ProcessId -Force -ErrorAction Stop }`;
	powershell(script);
}

function assertWindowsProfileAvailable(executablePath: string, profileDir: string): void {
	const profilePattern = windowsProfilePattern(profileDir);
	const active = powershell(
		`$active = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${psQuote(executablePath)} -and $_.CommandLine -match ${psQuote(profilePattern)} }); $active.Count`,
	);
	if (active !== "0") {
		throw new Error(`Windows browser profile is already active and is not owned by this launcher: ${profileDir}`);
	}
}

function windowsProfilePattern(profileDir: string): string {
	const escapedProfile = profileDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return `(?:^|\\s)(?:\"--user-data-dir=${escapedProfile}\"|--user-data-dir=\"${escapedProfile}\"|--user-data-dir=${escapedProfile})(?=\\s|$)`;
}

export function defaultPort(): number {
	return DEFAULT_REMOTE_DEBUGGING_PORT;
}

export function looksLikeWsl(): boolean {
	return isWsl();
}

function stopAllWindowsForwarders(): void {
	if (!fs.existsSync(FORWARDER_STATE_DIR)) return;
	const errors: unknown[] = [];
	for (const filename of fs.readdirSync(FORWARDER_STATE_DIR)) {
		if (!filename.endsWith(".json")) continue;
		try {
			stopWindowsForwarder(filename.slice(0, -5));
		} catch (cause) {
			errors.push(cause);
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "could not stop all Windows forwarders");
}

function forwarderStatePath(key: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`invalid forwarder key: ${key}`);
	return path.join(FORWARDER_STATE_DIR, `${key}.json`);
}

function readForwarderState(statePath: string): ForwarderState {
	const value = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
	const status = value.status;
	if (status !== "launching" && status !== "running") throw new Error("invalid forwarder status");
	const common: LaunchingForwarderState = {
		status: "launching",
		instanceId: requireString(value.instanceId, "forwarder instance ID"),
		scriptPath: requireString(value.scriptPath, "forwarder script path"),
		listenAddress: requireString(value.listenAddress, "forwarder listen address"),
		listenPort: requirePort(value.listenPort, "forwarder listen port"),
		targetAddress: requireString(value.targetAddress, "forwarder target address"),
		targetPort: requirePort(value.targetPort, "forwarder target port"),
	};
	return status === "running" ? { ...common, status, pid: requirePid(value.pid, "forwarder") } : common;
}

function readBrowserState(): BrowserState {
	const value = JSON.parse(fs.readFileSync(BROWSER_STATE_PATH, "utf8")) as Record<string, unknown>;
	const status = value.status;
	if (status !== "launching" && status !== "running") throw new Error("invalid browser status");
	const common: LaunchingBrowserState = { status: "launching", ownerId: requireString(value.ownerId, "browser owner ID"), executablePath: requireString(value.executablePath, "browser executable path"), profileDir: requireString(value.profileDir, "browser profile") };
	return status === "running" ? { ...common, status, pid: requirePid(value.pid, "browser"), creationTime: requireString(value.creationTime, "browser creation timestamp") } : common;
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	fs.renameSync(temporaryPath, filePath);
}

function requirePid(value: unknown, name: string): number {
	const text = String(value);
	if (!/^[1-9]\d*$/.test(text)) throw new Error(`invalid ${name} PID: ${text}`);
	const pid = Number(text);
	if (!Number.isSafeInteger(pid)) throw new Error(`invalid ${name} PID: ${text}`);
	return pid;
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${name}`);
	return value;
}

function requirePort(value: unknown, name: string): number {
	const port = Number(value);
	validatePort(port, name);
	return port;
}

function validatePort(port: number, name: string): void {
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid ${name}: ${port}`);
}

function shellQuote(value: string): string {
	return /[^\w@%+=:,./-]/.test(value) ? `'${value.replace(/'/g, "'\\''")}'` : value;
}
