import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultCdpUrl } from "./wsl.ts";

const RUNTIME_DIR =
	process.env.AGENT_BROWSER_RUNTIME_DIR ??
	path.join(os.tmpdir(), "agent-browser");

const CACHE_DIR =
	process.env.AGENT_BROWSER_CACHE_DIR ??
	path.join(os.homedir(), ".cache", "agent-browser");

export const paths = {
	runtimeDir: RUNTIME_DIR,
	cacheDir: CACHE_DIR,
	socket: path.join(RUNTIME_DIR, "daemon.sock"),
	pidFile: path.join(RUNTIME_DIR, "daemon.pid"),
	logFile: path.join(RUNTIME_DIR, "daemon.log"),
	profileDir: path.join(CACHE_DIR, "chrome-profile"),
	cdpUrlFile: path.join(RUNTIME_DIR, "cdp-url"),
} as const;

export const DEFAULT_REMOTE_DEBUGGING_PORT = 9222;

/**
 * Resolve the CDP URL to use. Priority:
 *   1. `$AGENT_BROWSER_CDP_URL` (explicit override)
 *   2. Persisted URL written by the last `ab chrome` launch (includes the
 *      forwarder port on WSL)
 *   3. Platform default: Windows host IP on WSL, loopback elsewhere
 */
export function getDefaultCdpUrl(): string {
	if (process.env.AGENT_BROWSER_CDP_URL) return process.env.AGENT_BROWSER_CDP_URL;
	try {
		const persisted = fs.readFileSync(paths.cdpUrlFile, "utf8").trim();
		if (persisted) return persisted;
	} catch {
		// no persisted file, fall through
	}
	return defaultCdpUrl(DEFAULT_REMOTE_DEBUGGING_PORT);
}

export function persistCdpUrl(url: string): void {
	fs.mkdirSync(RUNTIME_DIR, { recursive: true });
	fs.writeFileSync(paths.cdpUrlFile, url);
}

export function clearPersistedCdpUrl(): void {
	try {
		fs.unlinkSync(paths.cdpUrlFile);
	} catch {}
}
