import { execSync } from "node:child_process";
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
