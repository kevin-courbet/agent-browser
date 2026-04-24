import type { Browser, BrowserContext, Page } from "playwright";
import type { ConsoleEntry, NetworkEntry } from "../core/protocol.ts";

/**
 * Daemon-global state. Single instance per process.
 *
 * We attach one CDP browser and track pages across all contexts. Per-page
 * observability buffers (console + network) are bounded ring buffers keyed by
 * page to avoid unbounded growth on long-lived sessions.
 */

export interface AttachedSession {
	cdpUrl: string;
	browser: Browser;
	contexts: BrowserContext[];
}

class RingBuffer<T> {
	private buf: T[] = [];
	constructor(private readonly max: number) {}
	push(entry: T) {
		this.buf.push(entry);
		if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
	}
	clear() {
		this.buf = [];
	}
	slice(limit: number): T[] {
		return this.buf.slice(-limit);
	}
}

interface PageObservability {
	console: RingBuffer<ConsoleEntry>;
	network: RingBuffer<NetworkEntry>;
	// Map of request GUID -> { startedAt, method, url, resourceType }
	pendingRequests: Map<
		string,
		{ startedAt: number; method: string; url: string; resourceType: string }
	>;
}

export class DaemonState {
	readonly startedAt = Date.now();
	session: AttachedSession | null = null;
	activePage: Page | null = null;
	private readonly observability = new WeakMap<Page, PageObservability>();

	ensureObservability(page: Page): PageObservability {
		let obs = this.observability.get(page);
		if (!obs) {
			obs = {
				console: new RingBuffer<ConsoleEntry>(1000),
				network: new RingBuffer<NetworkEntry>(1000),
				pendingRequests: new Map(),
			};
			this.observability.set(page, obs);
		}
		return obs;
	}

	getObservability(page: Page): PageObservability | null {
		return this.observability.get(page) ?? null;
	}

	uptimeMs(): number {
		return Date.now() - this.startedAt;
	}
}
