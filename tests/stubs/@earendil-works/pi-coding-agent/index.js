export const getAgentDir = () => process.env.PI_AGENT_DIR_OVERRIDE || process.cwd() + "/fake-agent";

// Width-aware line limiting used by tool renderers. Without a terminal the lines are only split on
// newlines, which is enough for the offline tests; the real helper is exercised by load-check.mjs.
export const truncateToVisualLines = (text, maxVisualLines = 1) => {
	const lines = String(text ?? "").split("\n");
	return { visualLines: lines.slice(0, maxVisualLines), skippedCount: Math.max(0, lines.length - maxVisualLines) };
};
