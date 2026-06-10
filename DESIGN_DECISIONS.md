# Design Decisions
date|actor|scope|decision|rationale|code_refs
2026-06-10|agent|ab chrome --url launch behavior|`ab chrome --url <url>` launches Chrome with `<url>` as the initial target, prunes restored/stale page targets, and does not call `agent-browser open` after connect|Post-connect open created a second tab while persistent Chrome profile restore could resurrect old tabs; initial URL launch plus pruning preserves one requested page while retaining `about:blank` fallback for no-url launches|src/cli/index.ts:101,README.md:44
