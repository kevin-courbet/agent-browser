/**
 * Output formatting.
 *
 * `--json` emits raw JSON for machine consumers. Default is a human-readable
 * form tuned for each command (YAML snapshots, tabular tab/network lists,
 * compact status blocks). The goal is readable-at-a-glance output that an LLM
 * agent can parse without additional tooling.
 */

type Format = "text" | "json";

export function emit(format: Format, data: unknown, textRenderer?: () => string): void {
	if (format === "json") {
		process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
		return;
	}
	if (textRenderer) {
		process.stdout.write(`${textRenderer()}\n`);
		return;
	}
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function fail(err: unknown): never {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`error: ${msg}\n`);
	process.exit(1);
}
