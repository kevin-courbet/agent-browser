import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REMOTE_DEBUGGING_PORT, paths } from "../core/paths.ts";
import { isWsl, windowsHostIp, wslToWindowsPath } from "../core/wsl.ts";

/**
 * Chrome launcher.
 *
 * Three execution modes:
 *   - native (Linux/macOS): spawn the local chrome binary directly
 *   - wsl-windows: invoke `powershell.exe` to launch Chrome on the Windows host.
 *     We need this because from WSL we can't reach `localhost` on Windows, so
 *     we MUST bind Chrome's CDP endpoint to 0.0.0.0 and use the WSL gateway IP.
 *   - print-only: emit the command string for the user to run themselves
 *
 * A dedicated user-data-dir keeps the agent's browser isolated from the
 * user's daily browsing profile. Never clobbers their real session.
 */

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

export type LaunchMode = "native" | "wsl-windows" | "print";

export interface LaunchOptions {
	chromePath?: string | undefined;
	port: number;
	startUrl?: string | undefined;
	/**
	 * Where Chrome stores its profile. For wsl-windows, must be a Windows-style path.
	 * Defaults: Linux → `~/.cache/agent-browser/chrome-profile`,
	 * Windows (via WSL) → `%LOCALAPPDATA%\agent-browser\chrome-profile`.
	 */
	profileDir?: string | undefined;
	mode: LaunchMode;
	/** Bind CDP to 0.0.0.0 instead of 127.0.0.1 — ignored for wsl-windows (Chrome rejects it). */
	bindAll?: boolean | undefined;
	/**
	 * For wsl-windows only: port the Windows-side forwarder listens on. CDP URL
	 * returned points at `<windowsHostIp>:<forwarderPort>`. Defaults to `port + 1`.
	 */
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

const FORWARDER_PID_PATH = path.join(paths.runtimeDir, "windows-forwarder.pid");

export function resolveLinuxChromePath(hint?: string): string {
	if (hint) {
		if (!fs.existsSync(hint)) {
			throw new Error(`chrome binary not found at ${hint}`);
		}
		return hint;
	}
	for (const p of LINUX_CHROME_CANDIDATES) {
		if (fs.existsSync(p)) return p;
	}
	throw new Error(
		`could not find Chrome/Chromium. Pass --chrome <path> or install one of:\n  ${LINUX_CHROME_CANDIDATES.join("\n  ")}`,
	);
}

export function resolveWindowsChromePath(hint?: string): string {
	if (hint) return hint;
	// Check each candidate via `powershell Test-Path`. We can't stat Windows
	// paths directly from WSL without translating them, so ask PowerShell.
	for (const candidate of WINDOWS_CHROME_CANDIDATES) {
		try {
			const out = execSync(
				`powershell.exe -NoProfile -Command "Test-Path -LiteralPath '${candidate.replace(/'/g, "''")}'"`,
				{ encoding: "utf8", timeout: 5000 },
			).trim();
			if (out.toLowerCase() === "true") return candidate;
		} catch {
			// ignore and try the next
		}
	}
	// Fallback — assume user has Chrome installed at the most common path;
	// error will surface when we try to launch.
	return WINDOWS_CHROME_CANDIDATES[0]!;
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
	];
	if (opts.bindAll) {
		args.push("--remote-debugging-address=0.0.0.0");
	}
	if (opts.startUrl) args.push(opts.startUrl);
	return args;
}

export function defaultLinuxProfileDir(): string {
	return paths.profileDir;
}

/**
 * Default Windows profile dir, as a Windows path (Chrome on Windows won't like
 * a POSIX path even if we're invoking via powershell.exe).
 */
export function defaultWindowsProfileDir(): string {
	try {
		const out = execSync(
			`powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('LocalApplicationData')"`,
			{ encoding: "utf8", timeout: 5000 },
		).trim();
		if (out) return `${out}\\agent-browser\\chrome-profile`;
	} catch {
		// fallthrough
	}
	// Hardcoded fallback — will only bite if the user has an unusual profile layout.
	const user = process.env.USER ?? os.userInfo().username;
	return `C:\\Users\\${user}\\AppData\\Local\\agent-browser\\chrome-profile`;
}

export function launch(opts: LaunchOptions): LaunchResult {
	const bindAll = opts.bindAll ?? false;

	if (opts.mode === "wsl-windows") {
		fs.mkdirSync(paths.runtimeDir, { recursive: true });
		const profileDir = opts.profileDir ?? defaultWindowsProfileDir();
		const chromePath = resolveWindowsChromePath(opts.chromePath);
		// Chrome silently rejects --remote-debugging-address=0.0.0.0; leave it
		// bound to 127.0.0.1 and use a userspace forwarder instead.
		const args = buildChromeArgs({
			port: opts.port,
			profileDir,
			startUrl: opts.startUrl,
			bindAll: false,
		});
		const psArgs = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(", ");
		const psCmd = `Start-Process -FilePath '${chromePath.replace(/'/g, "''")}' -ArgumentList ${psArgs}`;
		const fullCmd = `powershell.exe -NoProfile -Command "${psCmd}"`;

		// Launch Chrome on Windows.
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-Command", psCmd],
			{ stdio: "ignore", detached: true },
		);
		child.unref();

		// Launch the Windows-side TCP forwarder so WSL can reach CDP.
		const forwarderPort = opts.forwarderPort ?? opts.port + 1;
		const host = windowsHostIp() ?? "127.0.0.1";
		const forwarderPid = startWindowsForwarder({
			listenAddress: host,
			listenPort: forwarderPort,
			targetPort: opts.port,
		});

		return {
			mode: "wsl-windows",
			pid: undefined,
			command: fullCmd,
			cdpUrl: `http://${host}:${forwarderPort}`,
			profileDir,
			forwarderPort,
			forwarderPid: forwarderPid ?? undefined,
		};
	}

	if (opts.mode === "print") {
		// Print-only — emit whichever style is appropriate.
		if (isWsl()) {
			const profileDir = opts.profileDir ?? defaultWindowsProfileDir();
			const chromePath = resolveWindowsChromePath(opts.chromePath);
			const args = buildChromeArgs({
				port: opts.port,
				profileDir,
				startUrl: opts.startUrl,
				bindAll: true,
			});
			const psArgs = args
				.map((a) => `'${a.replace(/'/g, "''")}'`)
				.join(", ");
			const psCmd = `Start-Process -FilePath '${chromePath.replace(/'/g, "''")}' -ArgumentList ${psArgs}`;
			const host = windowsHostIp() ?? "127.0.0.1";
			return {
				mode: "print",
				command: `powershell.exe -NoProfile -Command "${psCmd}"`,
				cdpUrl: `http://${host}:${opts.port}`,
				profileDir,
			};
		}
		const profileDir = opts.profileDir ?? defaultLinuxProfileDir();
		const chromePath = resolveLinuxChromePath(opts.chromePath);
		const args = buildChromeArgs({
			port: opts.port,
			profileDir,
			startUrl: opts.startUrl,
			bindAll,
		});
		return {
			mode: "print",
			command: `${shellQuote(chromePath)} ${args.map(shellQuote).join(" ")}`,
			cdpUrl: `http://127.0.0.1:${opts.port}`,
			profileDir,
		};
	}

	// native
	const profileDir = opts.profileDir ?? defaultLinuxProfileDir();
	fs.mkdirSync(profileDir, { recursive: true });
	const chromePath = resolveLinuxChromePath(opts.chromePath);
	const args = buildChromeArgs({
		port: opts.port,
		profileDir,
		startUrl: opts.startUrl,
		bindAll,
	});
	const child = spawn(chromePath, args, { stdio: "ignore", detached: true });
	child.unref();
	return {
		mode: "native",
		pid: child.pid,
		command: `${shellQuote(chromePath)} ${args.map(shellQuote).join(" ")}`,
		cdpUrl: `http://127.0.0.1:${opts.port}`,
		profileDir,
	};
}

function shellQuote(s: string): string {
	return /[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

export function defaultPort(): number {
	return DEFAULT_REMOTE_DEBUGGING_PORT;
}

export function looksLikeWsl(): boolean {
	return isWsl();
}

/**
 * Start the Windows-side TCP forwarder that bridges WSL → Chrome's loopback
 * CDP. Returns the forwarder's PID (on the Windows host) so we can kill it
 * later via `taskkill /PID`. Returns null if we couldn't read the pid back.
 *
 * Idempotent — kills any previous forwarder first.
 */
export function startWindowsForwarder(opts: {
	listenAddress: string;
	listenPort: number;
	targetPort: number;
}): number | null {
	stopWindowsForwarder();

	// Translate the .ps1 path to a Windows-style path so powershell.exe can load it.
	const psScriptWsl = fileURLToPath(
		new URL("./windows-forwarder.ps1", import.meta.url),
	);
	const psScriptWin = wslToWindowsPath(psScriptWsl);
	if (!psScriptWin) {
		throw new Error(
			`could not translate forwarder script path to Windows via wslpath: ${psScriptWsl}`,
		);
	}
	// Pid file — keep it on the Windows side to avoid WSL path translation in PS.
	const pidFileWsl = FORWARDER_PID_PATH;
	const pidFileWin = wslToWindowsPath(pidFileWsl) ?? pidFileWsl;
	fs.mkdirSync(path.dirname(pidFileWsl), { recursive: true });
	try {
		fs.unlinkSync(pidFileWsl);
	} catch {}

	const psCmd = `Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${psScriptWin.replace(/'/g, "''")}','-ListenAddress','${opts.listenAddress.replace(/'/g, "''")}','-ListenPort','${opts.listenPort}','-TargetPort','${opts.targetPort}','-PidFile','${pidFileWin.replace(/'/g, "''")}'`;
	const child = spawn("powershell.exe", ["-NoProfile", "-Command", psCmd], {
		stdio: "ignore",
		detached: true,
	});
	child.unref();

	// Poll for the pid file — the forwarder writes its PID there once launched.
	for (let i = 0; i < 30; i++) {
		try {
			const raw = fs.readFileSync(pidFileWsl, "utf8").trim();
			const pid = parseInt(raw, 10);
			if (Number.isFinite(pid)) return pid;
		} catch {}
		const end = Date.now() + 100;
		while (Date.now() < end) {
			// spin
		}
	}
	return null;
}

export function stopWindowsForwarder(): void {
	if (!fs.existsSync(FORWARDER_PID_PATH)) return;
	try {
		const raw = fs.readFileSync(FORWARDER_PID_PATH, "utf8").trim();
		const pid = parseInt(raw, 10);
		if (!Number.isFinite(pid)) return;
		execSync(`taskkill.exe /PID ${pid} /F`, {
			stdio: "ignore",
			timeout: 5000,
		});
	} catch {
		// ignore — may already be dead
	}
	try {
		fs.unlinkSync(FORWARDER_PID_PATH);
	} catch {}
}

export function stopAgentChrome(): void {
	stopWindowsForwarder();
	if (!looksLikeWsl()) return;

	const script = [
		"Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\"",
		"Where-Object { $_.CommandLine -like '*agent-browser*chrome-profile*' }",
		"ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
	].join(" | ");

	try {
		execSync(`powershell.exe -NoProfile -Command "${script}"`, {
			stdio: "ignore",
			timeout: 10_000,
		});
	} catch {
		// ignore — Chrome may already be gone
	}
}

// Silence unused warnings
void os;
