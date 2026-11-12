// Host stub for @earendil-works/pi-ai — only the surface `extensions/` imports.
//
// The thinking-level rules below are a faithful copy of pi-ai's `getSupportedThinkingLevels` and
// `clampThinkingLevel`, so an offline test sees the same levels a real model would expose. Everything
// else is a tagged literal: the schemas are only checked by `tests/load-check.mjs`, which runs Pi's own
// loader against the real packages.

export const StringEnum = (values, options) => ({ kind: "stringEnum", values, options });

const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Only a reasoning model has levels; `null` in the map marks one unsupported, `xhigh`/`max` need a mapping. */
export const getSupportedThinkingLevels = (model) => {
	if (!model?.reasoning) return ["off"];
	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
};

/** Nearest supported level at or above the requested one, then nearest below. */
export const clampThinkingLevel = (model, level) => {
	const available = getSupportedThinkingLevels(model);
	if (available.includes(level)) return level;
	const requested = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requested === -1) return available[0] ?? "off";
	for (let index = requested; index < EXTENDED_THINKING_LEVELS.length; index++) {
		if (available.includes(EXTENDED_THINKING_LEVELS[index])) return EXTENDED_THINKING_LEVELS[index];
	}
	for (let index = requested - 1; index >= 0; index--) {
		if (available.includes(EXTENDED_THINKING_LEVELS[index])) return EXTENDED_THINKING_LEVELS[index];
	}
	return available[0] ?? "off";
};
