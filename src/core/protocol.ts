import { z } from "zod";

/**
 * JSON-line protocol between CLI and daemon.
 *
 * Framing: one JSON object per line on the unix socket. CLI sends a Request,
 * daemon sends back exactly one Response with the matching `id`. Binary payloads
 * (screenshots) are base64-encoded in `data`.
 */

export const RequestSchema = z.object({
	id: z.string(),
	cmd: z.string(),
	args: z.unknown().optional(),
});
export type Request = z.infer<typeof RequestSchema>;

export const ResponseSchema = z.discriminatedUnion("ok", [
	z.object({ id: z.string(), ok: z.literal(true), data: z.unknown() }),
	z.object({ id: z.string(), ok: z.literal(false), error: z.string() }),
]);
export type Response = z.infer<typeof ResponseSchema>;

// ---------- Command argument schemas ----------

export const AttachArgs = z.object({
	debugUrl: z.string().url().optional(),
});
export const TabSwitchArgs = z.object({
	index: z.number().int().nonnegative().optional(),
	url: z.string().optional(),
});
export const NavigateArgs = z.object({
	url: z.string(),
	waitUntil: z
		.enum(["load", "domcontentloaded", "networkidle", "commit"])
		.default("load"),
});
export const SnapshotArgs = z.object({
	fullPage: z.boolean().default(false),
});
export const RefArgs = z.object({
	ref: z.string().regex(/^e\d+$/, "ref must look like e42"),
});
export const TypeArgs = RefArgs.extend({
	text: z.string(),
	submit: z.boolean().default(false),
	clear: z.boolean().default(true),
});
export const PressArgs = z.object({
	key: z.string(),
});
export const SelectArgs = RefArgs.extend({
	values: z.array(z.string()).min(1),
});
export const ScreenshotArgs = z.object({
	ref: z
		.string()
		.regex(/^e\d+$/)
		.optional(),
	fullPage: z.boolean().default(false),
	outPath: z.string().optional(),
});
export const EvalArgs = z.object({
	expression: z.string(),
});
export const BufferArgs = z.object({
	clear: z.boolean().default(false),
	limit: z.number().int().positive().max(5000).default(200),
	filter: z.string().optional(),
});
export const WaitArgs = z.object({
	ms: z.number().int().positive().max(120_000),
});

// ---------- Response data shapes (for typing daemon handlers) ----------

export interface StatusData {
	daemonPid: number;
	daemonUptimeMs: number;
	attached: boolean;
	cdpUrl: string | null;
	activeTab: TabInfo | null;
}
export interface TabInfo {
	index: number;
	url: string;
	title: string;
	active: boolean;
}
export interface SnapshotData {
	url: string;
	title: string;
	yaml: string;
	refCount: number;
}
export interface ConsoleEntry {
	timestamp: number;
	type: string;
	text: string;
	url?: string | undefined;
	lineno?: number | undefined;
}
export interface NetworkEntry {
	timestamp: number;
	method: string;
	url: string;
	status: number | null;
	resourceType: string;
	durationMs: number | null;
	failure: string | null;
}
