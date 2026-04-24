import fs from "node:fs/promises";
import { z } from "zod";
import type { Page } from "playwright";
import {
	AttachArgs,
	BufferArgs,
	EvalArgs,
	NavigateArgs,
	PressArgs,
	RefArgs,
	ScreenshotArgs,
	SelectArgs,
	SnapshotArgs,
	TabSwitchArgs,
	TypeArgs,
	WaitArgs,
	type ConsoleEntry,
	type NetworkEntry,
	type SnapshotData,
	type StatusData,
	type TabInfo,
} from "../core/protocol.ts";
import { PAGE_SNAPSHOT_SOURCE } from "../core/snapshot-page.ts";
import { attach, detach, ensureAttached, listPages } from "./attach.ts";
import type { DaemonState } from "./state.ts";

type Handler<I, O> = (state: DaemonState, args: I) => Promise<O>;

function requirePage(state: DaemonState): Page {
	if (!state.session) throw new Error("Not attached. Run `ab attach` first.");
	const page = state.activePage;
	if (!page || page.isClosed()) {
		throw new Error(
			"No active tab. Open a tab in Chrome and run `ab tab <index>`.",
		);
	}
	return page;
}

async function refLocator(page: Page, ref: string) {
	// Elements are tagged with data-ab-ref during snapshot; selector picks the one match.
	return page.locator(`[data-ab-ref="${ref}"]`).first();
}

// ---------- Handlers ----------

const status: Handler<void, StatusData> = async (state) => {
	const tab = state.activePage
		? await describeTab(state.activePage, 0, true)
		: null;
	return {
		daemonPid: process.pid,
		daemonUptimeMs: state.uptimeMs(),
		attached: !!state.session,
		cdpUrl: state.session?.cdpUrl ?? null,
		activeTab: tab,
	};
};

const attachCmd: Handler<z.infer<typeof AttachArgs>, { pages: number; cdpUrl: string }> =
	async (state, args) => {
		const parsed = AttachArgs.parse(args);
		const result = await attach(state, parsed.debugUrl);
		return {
			pages: result.pages,
			cdpUrl: state.session?.cdpUrl ?? "",
		};
	};

const detachCmd: Handler<void, { detached: true }> = async (state) => {
	await detach(state);
	return { detached: true };
};

async function describeTab(
	page: Page,
	index: number,
	active: boolean,
): Promise<TabInfo> {
	return {
		index,
		url: page.url(),
		title: await page.title().catch(() => ""),
		active,
	};
}

const tabs: Handler<void, TabInfo[]> = async (state) => {
	await ensureAttached(state);
	const pages = listPages(state);
	return Promise.all(
		pages.map((p, i) => describeTab(p, i, p === state.activePage)),
	);
};

const tab: Handler<z.infer<typeof TabSwitchArgs>, TabInfo> = async (state, args) => {
	const parsed = TabSwitchArgs.parse(args);
	await ensureAttached(state);
	const pages = listPages(state);
	let picked: Page | undefined;
	if (parsed.index !== undefined) picked = pages[parsed.index];
	else if (parsed.url) {
		picked = pages.find((p) => p.url().includes(parsed.url!));
	}
	if (!picked) throw new Error("No matching tab found.");
	state.activePage = picked;
	try {
		await picked.bringToFront();
	} catch {
		// non-fatal
	}
	return describeTab(picked, pages.indexOf(picked), true);
};

const navigate: Handler<z.infer<typeof NavigateArgs>, { url: string; status: number | null }> =
	async (state, args) => {
		const parsed = NavigateArgs.parse(args);
		const page = requirePage(state);
		const resp = await page.goto(parsed.url, {
			waitUntil: parsed.waitUntil,
			timeout: 30_000,
		});
		return { url: page.url(), status: resp?.status() ?? null };
	};

const back: Handler<void, { url: string }> = async (state) => {
	const page = requirePage(state);
	await page.goBack({ waitUntil: "load" });
	return { url: page.url() };
};

const forward: Handler<void, { url: string }> = async (state) => {
	const page = requirePage(state);
	await page.goForward({ waitUntil: "load" });
	return { url: page.url() };
};

const snapshot: Handler<z.infer<typeof SnapshotArgs>, SnapshotData> = async (
	state,
	args,
) => {
	SnapshotArgs.parse(args); // validate, unused for now
	const page = requirePage(state);
	// Wait for the DOM to be ready — avoids snapshotting mid-navigation.
	await page.waitForLoadState("domcontentloaded").catch(() => {});
	const result = await page.evaluate(
		`${PAGE_SNAPSHOT_SOURCE}(true)`,
	) as SnapshotData & { yaml: string; refCount: number };
	return result;
};

const click: Handler<z.infer<typeof RefArgs>, { ref: string; url: string }> = async (
	state,
	args,
) => {
	const parsed = RefArgs.parse(args);
	const page = requirePage(state);
	const loc = await refLocator(page, parsed.ref);
	await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
	await loc.click({ timeout: 10_000 });
	return { ref: parsed.ref, url: page.url() };
};

const type_: Handler<z.infer<typeof TypeArgs>, { ref: string }> = async (
	state,
	args,
) => {
	const parsed = TypeArgs.parse(args);
	const page = requirePage(state);
	const loc = await refLocator(page, parsed.ref);
	if (parsed.clear) await loc.fill("");
	await loc.fill(parsed.text);
	if (parsed.submit) await loc.press("Enter");
	return { ref: parsed.ref };
};

const press: Handler<z.infer<typeof PressArgs>, { key: string }> = async (
	state,
	args,
) => {
	const parsed = PressArgs.parse(args);
	const page = requirePage(state);
	await page.keyboard.press(parsed.key);
	return { key: parsed.key };
};

const hover: Handler<z.infer<typeof RefArgs>, { ref: string }> = async (
	state,
	args,
) => {
	const parsed = RefArgs.parse(args);
	const page = requirePage(state);
	const loc = await refLocator(page, parsed.ref);
	await loc.hover({ timeout: 10_000 });
	return { ref: parsed.ref };
};

const select: Handler<z.infer<typeof SelectArgs>, { ref: string; values: string[] }> =
	async (state, args) => {
		const parsed = SelectArgs.parse(args);
		const page = requirePage(state);
		const loc = await refLocator(page, parsed.ref);
		const chosen = await loc.selectOption(parsed.values);
		return { ref: parsed.ref, values: chosen };
	};

const screenshot: Handler<
	z.infer<typeof ScreenshotArgs>,
	{ path?: string; base64?: string; bytes: number }
> = async (state, args) => {
	const parsed = ScreenshotArgs.parse(args);
	const page = requirePage(state);
	const target = parsed.ref
		? await refLocator(page, parsed.ref)
		: null;
	const buf = target
		? await target.screenshot({ timeout: 10_000 })
		: await page.screenshot({ fullPage: parsed.fullPage });
	if (parsed.outPath) {
		await fs.writeFile(parsed.outPath, buf);
		return { path: parsed.outPath, bytes: buf.byteLength };
	}
	return { base64: buf.toString("base64"), bytes: buf.byteLength };
};

const evalCmd: Handler<z.infer<typeof EvalArgs>, { result: unknown }> = async (
	state,
	args,
) => {
	const parsed = EvalArgs.parse(args);
	const page = requirePage(state);
	// Wrap in (async () => (...))() so both expressions and statement bodies work,
	// and the user can `return foo` explicitly if they use a block.
	const wrapped = parsed.expression.trim().startsWith("return ")
		? `(async () => { ${parsed.expression} })()`
		: `(async () => (${parsed.expression}))()`;
	const result = await page.evaluate<unknown>(wrapped);
	return { result };
};

const consoleCmd: Handler<
	z.infer<typeof BufferArgs>,
	{ entries: ConsoleEntry[]; cleared: boolean }
> = async (state, args) => {
	const parsed = BufferArgs.parse(args);
	const page = requirePage(state);
	const obs = state.ensureObservability(page);
	if (parsed.clear) {
		obs.console.clear();
		return { entries: [], cleared: true };
	}
	let entries = obs.console.slice(parsed.limit);
	if (parsed.filter) {
		const re = new RegExp(parsed.filter, "i");
		entries = entries.filter(
			(e) => re.test(e.text) || re.test(e.type) || re.test(e.url ?? ""),
		);
	}
	return { entries, cleared: false };
};

const networkCmd: Handler<
	z.infer<typeof BufferArgs>,
	{ entries: NetworkEntry[]; cleared: boolean }
> = async (state, args) => {
	const parsed = BufferArgs.parse(args);
	const page = requirePage(state);
	const obs = state.ensureObservability(page);
	if (parsed.clear) {
		obs.network.clear();
		return { entries: [], cleared: true };
	}
	let entries = obs.network.slice(parsed.limit);
	if (parsed.filter) {
		const re = new RegExp(parsed.filter, "i");
		entries = entries.filter(
			(e) => re.test(e.url) || re.test(e.method) || re.test(e.resourceType),
		);
	}
	return { entries, cleared: false };
};

const wait: Handler<z.infer<typeof WaitArgs>, { waitedMs: number }> = async (
	_state,
	args,
) => {
	const parsed = WaitArgs.parse(args);
	await new Promise((r) => setTimeout(r, parsed.ms));
	return { waitedMs: parsed.ms };
};

export const handlers = {
	status,
	attach: attachCmd,
	detach: detachCmd,
	tabs,
	tab,
	navigate,
	back,
	forward,
	snapshot,
	click,
	type: type_,
	press,
	hover,
	select,
	screenshot,
	eval: evalCmd,
	console: consoleCmd,
	network: networkCmd,
	wait,
} satisfies Record<string, Handler<any, any>>;

export type CommandName = keyof typeof handlers;
