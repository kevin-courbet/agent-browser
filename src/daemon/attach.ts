import { chromium, type Browser, type Page } from "playwright";
import { getDefaultCdpUrl } from "../core/paths.ts";
import type { DaemonState } from "./state.ts";
import type { ConsoleEntry, NetworkEntry } from "../core/protocol.ts";

const wiredPages = new WeakSet<Page>();

/**
 * CDP attach with observability wiring.
 *
 * We connect over CDP to a user-launched Chrome, enumerate all existing pages,
 * and subscribe each to console + network listeners. Newly opened pages get
 * the same treatment via the `page` event on each context.
 *
 * If `activePage` is already set and still open after reattach, we keep it to
 * preserve ref continuity across daemon restarts (best-effort — the DOM may
 * have changed).
 */
export async function attach(
	state: DaemonState,
	cdpUrl: string = getDefaultCdpUrl(),
): Promise<{ pages: number }> {
	if (state.session) {
		await detach(state);
	}
	const browser = await chromium.connectOverCDP(cdpUrl);
	const contexts = browser.contexts();
	if (contexts.length === 0) {
		await browser.close();
		throw new Error(
			`CDP at ${cdpUrl} reported no browser contexts. Is Chrome really running with --remote-debugging-port?`,
		);
	}

	state.session = { cdpUrl, browser, contexts };

	const allPages: Page[] = [];
	for (const ctx of contexts) {
		for (const page of ctx.pages()) {
			wirePage(state, page);
			allPages.push(page);
		}
		ctx.on("page", (page) => {
			wirePage(state, page);
		});
	}

	if (!state.activePage || state.activePage.isClosed()) {
		state.activePage = allPages[0] ?? null;
	}

	browser.on("disconnected", () => {
		if (state.session?.browser === browser) {
			state.session = null;
			state.activePage = null;
		}
	});

	return { pages: allPages.length };
}

export async function detach(state: DaemonState): Promise<void> {
	if (!state.session) return;
	try {
		await state.session.browser.close();
	} catch {
		// ignore — user may have already killed Chrome
	}
	state.session = null;
	state.activePage = null;
}


export function wirePage(state: DaemonState, page: Page): void {
	if (wiredPages.has(page)) return;
	wiredPages.add(page);

	const obs = state.ensureObservability(page);

	page.on("console", (msg) => {
		const entry: ConsoleEntry = {
			timestamp: Date.now(),
			type: msg.type(),
			text: msg.text(),
			url: msg.location().url || undefined,
			lineno: msg.location().lineNumber || undefined,
		};
		obs.console.push(entry);
	});

	page.on("pageerror", (err) => {
		obs.console.push({
			timestamp: Date.now(),
			type: "pageerror",
			text: `${err.name}: ${err.message}\n${err.stack ?? ""}`.trim(),
		});
	});

	page.on("request", (req) => {
		obs.pendingRequests.set(guid(req), {
			startedAt: Date.now(),
			method: req.method(),
			url: req.url(),
			resourceType: req.resourceType(),
		});
	});

	page.on("requestfinished", async (req) => {
		const key = guid(req);
		const started = obs.pendingRequests.get(key);
		obs.pendingRequests.delete(key);
		const resp = await req.response().catch(() => null);
		const entry: NetworkEntry = {
			timestamp: started?.startedAt ?? Date.now(),
			method: req.method(),
			url: req.url(),
			status: resp?.status() ?? null,
			resourceType: req.resourceType(),
			durationMs: started ? Date.now() - started.startedAt : null,
			failure: null,
		};
		obs.network.push(entry);
	});

	page.on("requestfailed", (req) => {
		const key = guid(req);
		const started = obs.pendingRequests.get(key);
		obs.pendingRequests.delete(key);
		obs.network.push({
			timestamp: started?.startedAt ?? Date.now(),
			method: req.method(),
			url: req.url(),
			status: null,
			resourceType: req.resourceType(),
			durationMs: started ? Date.now() - started.startedAt : null,
			failure: req.failure()?.errorText ?? "unknown",
		});
	});

	page.on("close", () => {
		if (state.activePage === page) {
			// Pick any other live page
			state.activePage = pickAnyLivePage(state);
		}
	});
}

function pickAnyLivePage(state: DaemonState): Page | null {
	if (!state.session) return null;
	for (const ctx of state.session.contexts) {
		for (const page of ctx.pages()) {
			if (!page.isClosed()) return page;
		}
	}
	return null;
}

/** Playwright requests have no stable id, but the object identity is stable. */
const guidMap = new WeakMap<object, string>();
let guidCounter = 0;
function guid(obj: object): string {
	let id = guidMap.get(obj);
	if (!id) {
		id = `r${++guidCounter}`;
		guidMap.set(obj, id);
	}
	return id;
}

export async function ensureAttached(
	state: DaemonState,
	cdpUrl?: string,
): Promise<void> {
	if (!state.session) {
		await attach(state, cdpUrl ?? getDefaultCdpUrl());
	}
}

export function listPages(state: DaemonState): Page[] {
	if (!state.session) return [];
	const out: Page[] = [];
	for (const ctx of state.session.contexts) {
		for (const p of ctx.pages()) {
			if (!p.isClosed()) out.push(p);
		}
	}
	return out;
}

export function getActiveBrowser(state: DaemonState): Browser {
	if (!state.session) throw new Error("Not attached. Run `ab attach` first.");
	return state.session.browser;
}
