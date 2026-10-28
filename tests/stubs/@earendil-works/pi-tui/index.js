// Host stub for @earendil-works/pi-tui — only the surface `extensions/ask/` imports.
//
// There is no terminal here: rendering and key matching are plain-text approximations, enough for
// `tests/run.mjs` to load the module graph and for a future offline test of the component. The real
// module is exercised by `tests/load-check.mjs` (Pi's own loader) and by hand in the TUI.
// Keep this surface exactly in sync with the imports in `extensions/ask/`.

const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Visible terminal columns: ANSI escapes ignored, one code point per column. */
export function visibleWidth(value) {
	return Array.from(String(value).replace(ANSI_SEQUENCE, "")).length;
}

/** Word wrap that keeps the ANSI codes of the wrapped text (approximation: styles are not reopened). */
export function wrapTextWithAnsi(text, width) {
	const source = String(text);
	if (width <= 0) return [source];
	const out = [];
	for (const paragraph of source.split("\n")) {
		if (visibleWidth(paragraph) <= width) {
			out.push(paragraph);
			continue;
		}
		let current = "";
		for (const word of paragraph.split(/ /)) {
			const candidate = current ? `${current} ${word}` : word;
			if (visibleWidth(candidate) > width && current) {
				out.push(current);
				current = word;
			} else {
				current = candidate;
			}
		}
		if (current) out.push(current);
	}
	return out;
}

/** Truncate to a visible width, appending `ellipsis` when something was dropped. */
export function truncateToWidth(text, maxWidth, ellipsis = "...") {
	const source = String(text ?? "");
	if (maxWidth <= 0) return "";
	if (visibleWidth(source) <= maxWidth) return source;
	const dots = Array.from(ellipsis);
	const keep = Math.max(0, maxWidth - dots.length);
	const chars = Array.from(source.replace(ANSI_SEQUENCE, ""));
	return `${chars.slice(0, keep).join("")}${ellipsis}`;
}

export const Key = {
	escape: "escape",
	enter: "enter",
	tab: "tab",
	space: "space",
	backspace: "backspace",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	pageUp: "pageUp",
	pageDown: "pageDown",
	ctrl: (key) => `ctrl+${key}`,
	shift: (key) => `shift+${key}`,
	alt: (key) => `alt+${key}`,
};

// Raw bytes a test can produce -> key id. Mirrors `matchesKey` only for these codes.
const KEY_CODES = {
	"\u001b": "escape",
	"\u001b[13~": "enter",
	"\r": "enter",
	"\n": "enter",
	"\t": "tab",
	"\u001b[Z": "shift+tab",
	" ": "space",
	"\u007f": "backspace",
	"\u0003": "ctrl+c",
	"\u001b[A": "up",
	"\u001b[B": "down",
	"\u001b[C": "right",
	"\u001b[D": "left",
	"\u001b[5~": "pageUp",
	"\u001b[6~": "pageDown",
};

/** Match raw terminal input against a key id such as "escape", "up" or "ctrl+c". */
export function matchesKey(data, keyId) {
	if (typeof data !== "string" || typeof keyId !== "string") return false;
	return (KEY_CODES[data] ?? data) === keyId;
}

export class Text {
	constructor(text = "", paddingX = 0, paddingY = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}
	setText(text) {
		this.text = text;
	}
	invalidate() {}
	render(width) {
		const inner = Math.max(1, width - this.paddingX * 2);
		const wrapped = wrapTextWithAnsi(this.text, inner);
		const blank = " ".repeat(this.paddingX);
		return [...Array.from({ length: this.paddingY }, () => ""), ...wrapped.map((line) => `${blank}${line}`)];
	}
}

/** Single-line text editor: enough behavior to drive `onSubmit` from a test. */
export class Editor {
	constructor(tui, theme, options) {
		this.tui = tui;
		this.theme = theme;
		this.paddingX = options?.paddingX ?? 0;
		this.text = "";
		this.focused = false;
		this.onSubmit = undefined;
		this.onChange = undefined;
		this.disableSubmit = false;
	}
	setText(text) {
		this.text = String(text ?? "");
		this.onChange?.(this.text);
	}
	getText() {
		return this.text;
	}
	handleInput(data) {
		if (data === "\u007f" || data === "\b") {
			this.text = this.text.slice(0, -1);
			this.onChange?.(this.text);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.disableSubmit) return;
			this.onSubmit?.(this.text);
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return;
		if (/[\u001b]/.test(data) || data.startsWith("\u001b[")) return;
		this.text += data;
		this.onChange?.(this.text);
	}
	invalidate() {}
	render(width) {
		const inner = Math.max(1, width - 2);
		return [`\u250c${"\u2500".repeat(inner)}\u2510`, `\u2502 ${truncateToWidth(this.text, inner - 1)}`, `\u2514${"\u2500".repeat(inner)}\u2518`];
	}
}
