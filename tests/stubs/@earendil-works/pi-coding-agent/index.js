export const getAgentDir = () => process.env.PI_AGENT_DIR_OVERRIDE || process.cwd() + "/fake-agent";

/**
 * Spinner box with an abort signal, as `ctx.ui.custom()` uses it. Offline there is nothing to animate:
 * the stub only keeps the surface the extensions touch (`signal`, `onAbort`), so a test can drive the
 * factory the same way the terminal would.
 */
export class BorderedLoader {
	constructor(_tui, _theme, message) {
		this.message = message;
		this.controller = new AbortController();
		this.onAbort = undefined;
		this.controller.signal.addEventListener("abort", () => this.onAbort?.());
	}

	get signal() {
		return this.controller.signal;
	}

	abort() {
		this.controller.abort();
	}
}

// Width-aware line limiting used by tool renderers. Without a terminal the lines are only split on
// newlines, which is enough for the offline tests; the real helper is exercised by load-check.mjs.
export const truncateToVisualLines = (text, maxVisualLines = 1) => {
	const lines = String(text ?? "").split("\n");
	return { visualLines: lines.slice(0, maxVisualLines), skippedCount: Math.max(0, lines.length - maxVisualLines) };
};
