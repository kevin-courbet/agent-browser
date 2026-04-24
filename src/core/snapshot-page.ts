/**
 * Browser-side snapshot generator.
 *
 * Runs inside the page via `page.evaluate`. Walks the live DOM + accessibility
 * semantics, tags interesting elements with `data-ab-ref="e<n>"`, and returns
 * a YAML-ish tree that mirrors the structure BrowserMCP emits (close enough
 * that agents used to that format work without retraining).
 *
 * Stays self-contained — no TS helpers, no imports. String-inlined into the
 * page. Receives a `clearPrevious` flag so we can wipe stale refs from prior
 * snapshots before re-tagging.
 */

export type SnapshotResult = {
	yaml: string;
	refCount: number;
	url: string;
	title: string;
};

// This function is serialised to a string and evaluated inside the page.
// Keep it dependency-free (no TS helpers, no imports, no optional chaining
// on types-only values). It's authored as a regular function so TS still
// checks the body.
export function pageSnapshotFn(clearPrevious: boolean): SnapshotResult {
	const INTERESTING_ROLES = new Set([
		"button",
		"link",
		"textbox",
		"checkbox",
		"radio",
		"combobox",
		"listbox",
		"option",
		"menuitem",
		"menuitemcheckbox",
		"menuitemradio",
		"tab",
		"switch",
		"slider",
		"spinbutton",
		"searchbox",
		"heading",
		"img",
		"figure",
		"dialog",
		"alertdialog",
		"alert",
		"status",
		"progressbar",
		"tooltip",
		"menu",
		"menubar",
		"toolbar",
		"navigation",
		"main",
		"banner",
		"contentinfo",
		"complementary",
		"region",
		"article",
		"list",
		"listitem",
		"table",
		"row",
		"cell",
		"columnheader",
		"rowheader",
		"form",
		"separator",
	]);

	const CONTAINER_ROLES = new Set([
		"list",
		"menu",
		"menubar",
		"toolbar",
		"navigation",
		"main",
		"banner",
		"contentinfo",
		"complementary",
		"region",
		"article",
		"dialog",
		"alertdialog",
		"table",
		"row",
		"form",
	]);

	if (clearPrevious) {
		const stale = document.querySelectorAll("[data-ab-ref]");
		stale.forEach((el) => el.removeAttribute("data-ab-ref"));
	}

	let counter = 0;
	const lines: string[] = [];

	function roleOf(el: Element): string | null {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit.trim().split(/\s+/)[0] ?? null;
		const tag = el.tagName.toLowerCase();
		switch (tag) {
			case "a":
				return el.hasAttribute("href") ? "link" : null;
			case "button":
				return "button";
			case "nav":
				return "navigation";
			case "main":
				return "main";
			case "header":
				return el.closest("article,section") ? null : "banner";
			case "footer":
				return el.closest("article,section") ? null : "contentinfo";
			case "aside":
				return "complementary";
			case "section":
				return el.hasAttribute("aria-label") ||
					el.hasAttribute("aria-labelledby")
					? "region"
					: null;
			case "article":
				return "article";
			case "form":
				return el.hasAttribute("aria-label") ||
					el.hasAttribute("aria-labelledby")
					? "form"
					: null;
			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6":
				return "heading";
			case "img": {
				const alt = el.getAttribute("alt");
				if (alt === "") return null;
				return "img";
			}
			case "ul":
			case "ol":
				return "list";
			case "li":
				return "listitem";
			case "table":
				return "table";
			case "tr":
				return "row";
			case "td":
				return "cell";
			case "th":
				return "columnheader";
			case "dialog":
				return "dialog";
			case "figure":
				return "figure";
			case "hr":
				return "separator";
			case "input": {
				const type = (el.getAttribute("type") ?? "text").toLowerCase();
				if (type === "checkbox") return "checkbox";
				if (type === "radio") return "radio";
				if (type === "range") return "slider";
				if (type === "number") return "spinbutton";
				if (type === "search") return "searchbox";
				if (type === "submit" || type === "button" || type === "reset")
					return "button";
				if (type === "hidden") return null;
				return "textbox";
			}
			case "textarea":
				return "textbox";
			case "select":
				return "combobox";
			case "option":
				return "option";
			case "label":
				return null;
			case "p":
				return "paragraph";
			case "svg":
				return el.hasAttribute("role") ? el.getAttribute("role") : null;
			default:
				return null;
		}
	}

	function accessibleName(el: Element): string {
		const aria = el.getAttribute("aria-label");
		if (aria && aria.trim()) return aria.trim();
		const labelledby = el.getAttribute("aria-labelledby");
		if (labelledby) {
			const parts: string[] = [];
			labelledby.split(/\s+/).forEach((id) => {
				const ref = document.getElementById(id);
				if (ref) parts.push((ref.textContent ?? "").trim());
			});
			const joined = parts.join(" ").trim();
			if (joined) return joined;
		}
		if (el.tagName === "IMG") {
			const alt = el.getAttribute("alt");
			if (alt) return alt.trim();
		}
		if (el.tagName === "INPUT") {
			const input = el as HTMLInputElement;
			const id = input.id;
			if (id) {
				const lbl = document.querySelector<HTMLLabelElement>(
					`label[for="${CSS.escape(id)}"]`,
				);
				if (lbl) return (lbl.textContent ?? "").trim();
			}
			const placeholder = input.getAttribute("placeholder");
			if (placeholder) return placeholder.trim();
			const title = input.getAttribute("title");
			if (title) return title.trim();
		}
		if (el.tagName === "BUTTON" || el.tagName === "A") {
			const title = el.getAttribute("title");
			const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
			if (text) return text.slice(0, 120);
			if (title) return title;
		}
		const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
		return text.slice(0, 120);
	}

	function isVisible(el: Element): boolean {
		if (!(el instanceof HTMLElement) && !(el instanceof SVGElement))
			return true;
		const rect = el.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			// Off-screen but not display:none — still allow if it has children
			if (!el.firstElementChild) return false;
		}
		const style = window.getComputedStyle(el);
		if (style.display === "none") return false;
		if (style.visibility === "hidden" || style.visibility === "collapse")
			return false;
		if (style.opacity === "0") return false;
		return true;
	}

	function yamlEscape(s: string): string {
		if (!s) return '""';
		if (/^[\w .,!?/:€$%'\-+@àâäçéèêëîïôöùûüÿ]+$/i.test(s) && !s.includes("\n"))
			return `"${s.replace(/"/g, '\\"')}"`;
		return JSON.stringify(s);
	}

	function emit(el: Element, depth: number): number {
		if (!isVisible(el)) return 0;
		const role = roleOf(el);
		const name = accessibleName(el);
		const interesting =
			role !== null &&
			(INTERESTING_ROLES.has(role) ||
				role === "paragraph" ||
				role === "heading");

		let localEmitted = 0;
		let indent = "  ".repeat(depth);
		let childDepth = depth;

		if (interesting) {
			counter += 1;
			const ref = `e${counter}`;
			el.setAttribute("data-ab-ref", ref);
			localEmitted = 1;
			let line = `${indent}- ${role}`;
			if (role === "heading") {
				const tag = el.tagName.toLowerCase();
				if (tag.startsWith("h") && tag.length === 2) {
					line += ` [level=${tag[1]}]`;
				}
			}
			if (name) {
				line += ` ${yamlEscape(name)}`;
			}
			line += ` [ref=${ref}]`;
			if (el.tagName === "A") {
				const href = el.getAttribute("href");
				if (href) line += `\n${indent}  # url: ${href}`;
			}
			lines.push(line);
			childDepth = depth + 1;
		}

		// Recurse into children for container-like roles or when not interesting
		const shouldRecurse =
			!interesting ||
			role === null ||
			CONTAINER_ROLES.has(role ?? "") ||
			el.children.length <= 30;

		if (shouldRecurse) {
			for (let i = 0; i < el.children.length; i++) {
				const child = el.children[i];
				if (child) localEmitted += emit(child, childDepth);
			}
		}
		return localEmitted;
	}

	// Document header
	lines.push(`# url: ${window.location.href}`);
	lines.push(`# title: ${yamlEscape(document.title || "")}`);
	emit(document.body, 0);

	return {
		yaml: lines.join("\n"),
		refCount: counter,
		url: window.location.href,
		title: document.title,
	};
}

/** Source string for `page.evaluate` — avoids TS transpilation surprises. */
export const PAGE_SNAPSHOT_SOURCE = `(${pageSnapshotFn.toString()})`;
