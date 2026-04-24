import fs from "node:fs";
import net from "node:net";
import { paths } from "../core/paths.ts";
import { ResponseSchema } from "../core/protocol.ts";

/**
 * One-shot JSON-line client. Sends a request, waits for the matching response,
 * then closes the socket.
 *
 * If the daemon isn't running, we auto-spawn it (detached) and retry a few
 * times — the agent loop expects `ab` to just work without manual bootstrap.
 */

export class DaemonNotRunningError extends Error {
	constructor() {
		super(
			`agent-browser daemon not running at ${paths.socket}. Start it with \`ab daemon start\`.`,
		);
	}
}

export async function send(
	cmd: string,
	args: unknown = {},
	opts: { autostart?: boolean; timeoutMs?: number } = {},
): Promise<unknown> {
	const autostart = opts.autostart ?? true;
	const timeoutMs = opts.timeoutMs ?? 45_000;
	try {
		return await sendOnce(cmd, args, timeoutMs);
	} catch (err) {
		if (!autostart) throw err;
		if (!isConnectionRefused(err)) throw err;
		await autostartDaemon();
		return await sendOnce(cmd, args, timeoutMs);
	}
}

async function sendOnce(
	cmd: string,
	args: unknown,
	timeoutMs: number,
): Promise<unknown> {
	const id = Math.random().toString(36).slice(2);
	const payload = `${JSON.stringify({ id, cmd, args })}\n`;
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(paths.socket);
		let buffer = "";
		const timer = setTimeout(() => {
			socket.destroy(new Error(`timeout after ${timeoutMs}ms waiting for ${cmd}`));
		}, timeoutMs);

		socket.on("connect", () => {
			socket.write(payload);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const idx = buffer.indexOf("\n");
			if (idx < 0) return;
			const line = buffer.slice(0, idx);
			clearTimeout(timer);
			try {
				const resp = ResponseSchema.parse(JSON.parse(line));
				if (resp.id !== id) {
					reject(new Error(`id mismatch: expected ${id} got ${resp.id}`));
				} else if (!resp.ok) {
					reject(new Error(resp.error));
				} else {
					resolve(resp.data);
				}
			} catch (err) {
				reject(err);
			}
			socket.end();
		});
		socket.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

function isConnectionRefused(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const code = (err as { code?: string }).code;
	return (
		code === "ECONNREFUSED" ||
		code === "ENOENT" ||
		code === "ECONNRESET"
	);
}

/**
 * Auto-spawn the daemon.
 *
 * Playwright's CDP client fails under Bun (WebSocket upgrade hangs in
 * `connectOverCDP`), so we explicitly run the daemon under Node. Node 22+ strips
 * TS types natively. The CLI stays on Bun for fast startup.
 *
 * `AGENT_BROWSER_NODE` overrides the node binary. We resolve via PATH by default.
 */
async function autostartDaemon(): Promise<void> {
	// Check for an obviously dead pid file and wipe it.
	if (fs.existsSync(paths.pidFile)) {
		const pid = parseInt(fs.readFileSync(paths.pidFile, "utf8").trim(), 10);
		if (Number.isFinite(pid) && !isPidAlive(pid)) {
			fs.unlinkSync(paths.pidFile);
		}
	}
	fs.mkdirSync(paths.runtimeDir, { recursive: true });
	const daemonEntry = new URL("../daemon/index.ts", import.meta.url).pathname;
	const nodeBin = process.env.AGENT_BROWSER_NODE ?? "node";
	const logFd = fs.openSync(paths.logFile, "a");
	const child = Bun.spawn({
		cmd: [
			nodeBin,
			"--experimental-strip-types",
			"--experimental-transform-types",
			"--disable-warning=ExperimentalWarning",
			daemonEntry,
		],
		stdio: ["ignore", logFd, logFd],
		env: { ...process.env },
	});
	// Detach so daemon outlives this CLI invocation.
	child.unref();
	// Poll for socket readiness
	for (let i = 0; i < 100; i++) {
		await new Promise((r) => setTimeout(r, 100));
		if (fs.existsSync(paths.socket)) return;
	}
	throw new Error(
		`daemon started but socket never appeared at ${paths.socket}. See ${paths.logFile}.`,
	);
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
