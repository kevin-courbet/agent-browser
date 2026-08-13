import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";

/**
 * WSL2 ↔ Windows bridging helpers.
 *
 * Under WSL2 we live in a different Linux VM from the Windows host. To attach
 * to Windows Chrome we need two things:
 *   1. The Windows host's IP as seen from WSL (usually the default gateway)
 *   2. A way to launch Windows binaries — `powershell.exe` is on PATH via
 *      WSL's interop layer.
 *
 * We NEVER rely on `localhost` for Windows services from WSL2 (NAT mode) —
 * `localhost` maps to WSL itself, not Windows. Mirrored networking mode is
 * different but we can't assume it.
 */

export function isWsl(): boolean {
	if (process.env.WSL_DISTRO_NAME) return true;
	try {
		return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

let cachedHostIp: string | null | undefined;
let cachedGuestIp: string | null | undefined;
let cachedMirroredNetworking: boolean | undefined;

/**
 * Windows host IP as reachable from WSL2.
 *
 * In NAT mode (the default), the Windows host is the default gateway of the
 * WSL VM. In mirrored mode, `localhost` works both ways — in that case this
 * returns `127.0.0.1` so CDP attach still works.
 */
export function windowsHostIp(): string | null {
	if (cachedHostIp !== undefined) return cachedHostIp;
	if (!isWsl()) return (cachedHostIp = null);
	try {
		const out = execSync("ip route show default", {
			encoding: "utf8",
			timeout: 2000,
		});
		const m = out.match(/default via (\d+\.\d+\.\d+\.\d+)/);
		if (m?.[1]) return (cachedHostIp = m[1]);
	} catch {
		// fallthrough
	}
	// Fallback: /etc/resolv.conf nameserver is often the Windows host too,
	// depending on WSL config.
	try {
		const resolv = fs.readFileSync("/etc/resolv.conf", "utf8");
		const m = resolv.match(/^nameserver\s+(\d+\.\d+\.\d+\.\d+)/m);
		if (m?.[1]) return (cachedHostIp = m[1]);
	} catch {
		// fallthrough
	}
	return (cachedHostIp = null);
}

/** WSL guest address that Windows can use to reach services bound to all interfaces. */
export function wslGuestIp(): string | null {
	if (cachedGuestIp !== undefined) return cachedGuestIp;
	const host = windowsHostIp();
	if (!host) return (cachedGuestIp = null);
	try {
		const out = execFileSync("ip", ["-4", "route", "get", host], {
			encoding: "utf8",
			timeout: 2000,
		});
		const match = out.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)\b/);
		if (match?.[1]) return (cachedGuestIp = match[1]);
	} catch {
		// fall through
	}
	return (cachedGuestIp = null);
}

export function hasMirroredNetworking(): boolean {
	if (cachedMirroredNetworking !== undefined) return cachedMirroredNetworking;
	if (!isWsl()) return (cachedMirroredNetworking = false);
	try {
		const mode = execFileSync("wslinfo", ["--networking-mode"], {
			encoding: "utf8",
			timeout: 2000,
		}).trim();
		return (cachedMirroredNetworking = mode === "mirrored");
	} catch {
		return (cachedMirroredNetworking = false);
	}
}

export type LoopbackUrl = {
	url: string;
	listenAddress: string;
	port: number;
};

/** Parse loopback HTTP(S) URLs that need a Windows-to-WSL forwarder. */
export function parseLoopbackUrl(rawUrl: string): LoopbackUrl | null {
	const explicitHttpUrl = /^https?:\/\//i.test(rawUrl);
	const malformedHttpUrl = /^https?:/i.test(rawUrl) && !explicitHttpUrl;
	if (malformedHttpUrl) throw new Error(`invalid HTTP(S) URL: ${rawUrl}`);
	const bareLoopbackUrl = /^(?:localhost\.?|127(?:\.\d{1,3}){3}|\[::1\])(?=[:/?#]|$)/i.test(rawUrl);
	if (!explicitHttpUrl && !bareLoopbackUrl) return null;

	let url: URL;
	try {
		url = new URL(explicitHttpUrl ? rawUrl : `http://${rawUrl}`);
	} catch (cause) {
		throw new Error(`invalid HTTP(S) URL: ${rawUrl}`, { cause });
	}
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	const ipv4 = hostname.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	const ipv4Loopback = ipv4?.slice(1).every((part) => Number(part) <= 255) ?? false;
	if (hostname !== "localhost" && hostname !== "[::1]" && !ipv4Loopback) {
		return null;
	}

	const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`invalid URL port: ${rawUrl}`);
	}
	const listenAddress = hostname === "[::1]" ? "::1" : ipv4Loopback ? hostname : "127.0.0.1";
	return { url: explicitHttpUrl ? rawUrl : `http://${rawUrl}`, listenAddress, port };
}

/**
 * Preferred CDP URL when the caller hasn't been explicit. On WSL we point at
 * the Windows host; elsewhere at loopback.
 */
export function defaultCdpUrl(port = 9222): string {
	if (process.env.AGENT_BROWSER_CDP_URL)
		return process.env.AGENT_BROWSER_CDP_URL;
	const ip = windowsHostIp();
	const host = ip ?? "127.0.0.1";
	return `http://${host}:${port}`;
}

/**
 * Translate a WSL path like `/home/wsl/foo` to a Windows path `\\wsl$\...`
 * via `wslpath -w`. Returns null if not on WSL or the translation fails.
 */
export function wslToWindowsPath(p: string): string | null {
	if (!isWsl()) return null;
	try {
		return execSync(`wslpath -w ${shellQuote(p)}`, {
			encoding: "utf8",
			timeout: 2000,
		}).trim();
	} catch {
		return null;
	}
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
