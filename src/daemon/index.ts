import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { paths } from "../core/paths.ts";
import { RequestSchema, type Response } from "../core/protocol.ts";
import { handlers, type CommandName } from "./handlers.ts";
import { DaemonState } from "./state.ts";

/**
 * Daemon entrypoint.
 *
 * Unix-socket JSON-line server. One connection per CLI invocation; the CLI
 * sends one request, waits for one response, and disconnects. We allow
 * multiple concurrent connections so a long-running `console --follow` (future)
 * doesn't block other commands.
 */

function log(...args: unknown[]): void {
	const line = `[${new Date().toISOString()}] ${args
		.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
		.join(" ")}\n`;
	fs.appendFileSync(paths.logFile, line);
	// Also echo to stderr so `ab daemon` in foreground shows output.
	process.stderr.write(line);
}

async function main(): Promise<void> {
	fs.mkdirSync(paths.runtimeDir, { recursive: true });
	// Clean stale socket
	if (fs.existsSync(paths.socket)) fs.unlinkSync(paths.socket);
	// Write pid file
	fs.writeFileSync(paths.pidFile, String(process.pid));

	const state = new DaemonState();

	const server = net.createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (!line.trim()) continue;
				handleLine(state, socket, line).catch((err) => {
					log("handler crash", String(err));
				});
			}
		});
		socket.on("error", (err) => {
			log("socket error", err.message);
		});
	});

	server.listen(paths.socket, () => {
		// Make it only user-accessible
		try {
			fs.chmodSync(paths.socket, 0o600);
		} catch {}
		log(`daemon listening on ${paths.socket} pid=${process.pid}`);
	});

	function shutdown(reason: string) {
		log(`shutting down: ${reason}`);
		server.close(() => {
			try {
				if (fs.existsSync(paths.pidFile)) fs.unlinkSync(paths.pidFile);
				if (fs.existsSync(paths.socket)) fs.unlinkSync(paths.socket);
			} catch {}
			process.exit(0);
		});
	}
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("uncaughtException", (err) => {
		log("uncaughtException", err.stack ?? err.message);
	});
	process.on("unhandledRejection", (err) => {
		log("unhandledRejection", err instanceof Error ? err.stack ?? err.message : String(err));
	});
}

async function handleLine(
	state: DaemonState,
	socket: net.Socket,
	line: string,
): Promise<void> {
	let req: ReturnType<typeof RequestSchema.parse>;
	try {
		req = RequestSchema.parse(JSON.parse(line));
	} catch (err) {
		const resp: Response = {
			id: "unknown",
			ok: false,
			error: `invalid request: ${err instanceof Error ? err.message : String(err)}`,
		};
		socket.write(`${JSON.stringify(resp)}\n`);
		return;
	}

	const cmd = req.cmd as CommandName;
	const handler = handlers[cmd];
	if (!handler) {
		const resp: Response = {
			id: req.id,
			ok: false,
			error: `unknown command: ${req.cmd}`,
		};
		socket.write(`${JSON.stringify(resp)}\n`);
		return;
	}

	try {
		const t0 = Date.now();
		const data = await (handler as (s: DaemonState, a: unknown) => Promise<unknown>)(
			state,
			req.args ?? {},
		);
		const resp: Response = { id: req.id, ok: true, data };
		socket.write(`${JSON.stringify(resp)}\n`);
		log(`${cmd} ok ${Date.now() - t0}ms`);
	} catch (err) {
		const resp: Response = {
			id: req.id,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
		socket.write(`${JSON.stringify(resp)}\n`);
		log(`${cmd} err ${resp.error}`);
	}
}

main().catch((err) => {
	process.stderr.write(
		`daemon failed to start: ${err instanceof Error ? err.stack : String(err)}\n`,
	);
	process.exit(1);
});

// Make TS see this as a module
export {};

// Side effect import for path at top; kept for future structured logs
void path;
