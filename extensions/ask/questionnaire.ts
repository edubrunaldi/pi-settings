/**
 * ask — the interactive picker component.
 *
 * Drawn inline by `ctx.ui.custom()`: it takes the editor area for the length of the interaction and
 * resolves ONLY through the `done` callback it is given. Two failure modes are fatal here, so they are
 * designed out:
 *
 * - softlock: cancel (`tui.select.cancel`, Esc, Ctrl+C) is checked first and in every state, including
 *   while the free-form editor is open. A custom component has no other exit — `Ctrl+C` in Pi is clear
 *   editor / shutdown, and an `Esc` that is swallowed leaves the terminal owned by a dead dialog;
 * - over-wide lines: the render cache is keyed by width, and every line is produced by
 *   `wrapTextWithAnsi`/`truncateToWidth` with prefixes measured by `visibleWidth`, so a resize reflows.
 *
 * Keys are matched as configurable actions first and as hard-coded keys second, so a user keymap keeps
 * working while the defaults do not depend on the manager's contents.
 *
 * State is owned here (cursor, question tab, picks, written answers, mode); the data rules live in
 * `logic.ts`.
 */

import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	CUSTOM_LABEL,
	customIndexOf,
	isAnswered,
	optionsFor,
	sanitizeText,
	selectSingle,
	togglePick,
	type AskOption,
	type AskQuestion,
} from "./logic.ts";

/** Option rows drawn at once; the rest stays reachable through ↑/↓ with a "n more" hint. */
export const MAX_VISIBLE_OPTIONS = 8;

/** Numbered option rows: "> " cursor + 3-column marker + space. Descriptions align after "N. ". */
const ROW_PREFIX_WIDTH = 6;
const DESCRIPTION_PREFIX_WIDTH = 9;

/** What the user left behind in the picker. */
export interface PickerResult {
	cancelled: boolean;
	/** Picks per question, as indices into `optionsFor(question)`. */
	picks: number[][];
	/** Written answer per question ("" when the user did not write one). */
	customs: string[];
}

export interface QuestionnaireOptions {
	questions: readonly AskQuestion[];
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	done: (result: PickerResult) => void;
}

/** A custom component that can hold focus (for the inline editor) and be disposed. */
export type Questionnaire = Component & Focusable & { dispose(): void };

/**
 * Build the picker. The interaction ends through `options.done`, which resolves `ctx.ui.custom()`; after
 * that the component ignores input, so a late key press cannot answer twice.
 */
export function createQuestionnaire(input: QuestionnaireOptions): Questionnaire {
	const { questions, tui, theme, keybindings, done } = input;

	// The free-form editor is a real `Editor`: IME, paste and the hardware cursor stay pi-tui's job.
	const editorTheme: EditorTheme = {
		borderColor: (value) => theme.fg("accent", value),
		selectList: {
			selectedPrefix: (value) => theme.fg("accent", value),
			selectedText: (value) => theme.fg("accent", value),
			description: (value) => theme.fg("muted", value),
			scrollInfo: (value) => theme.fg("dim", value),
			noMatch: (value) => theme.fg("warning", value),
		},
	};
	const editor = new Editor(tui, editorTheme);

	const picks: number[][] = questions.map(() => []);
	const customs: string[] = questions.map(() => "");

	let questionIndex = 0;
	let optionIndex = 0;
	let mode: "options" | "custom" = "options";
	let warning = "";
	let focused = false;
	let closed = false;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	// ---------------------------------------------------------------- keys

	const isCancelKey = (data: string): boolean =>
		keybindings.matches(data, "tui.select.cancel") ||
		matchesKey(data, Key.escape) ||
		matchesKey(data, Key.ctrl("c"));
	const isUpKey = (data: string): boolean => keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up);
	const isDownKey = (data: string): boolean =>
		keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down);
	const isConfirmKey = (data: string): boolean =>
		keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter);
	const isNextTabKey = (data: string): boolean =>
		keybindings.matches(data, "tui.input.tab") || matchesKey(data, Key.tab) || matchesKey(data, Key.right);
	const isPreviousTabKey = (data: string): boolean =>
		matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left);
	const isToggleKey = (data: string): boolean => matchesKey(data, Key.space) || data === " ";

	// ---------------------------------------------------------------- state

	function currentQuestion(): AskQuestion {
		return questions[questionIndex];
	}

	function isCustomRow(): boolean {
		return optionIndex === customIndexOf(currentQuestion());
	}

	/** Entering a tab again puts the cursor on what was already chosen, when something was. */
	function cursorForQuestion(): number {
		const rows = optionsFor(questions[questionIndex]);
		const chosen = picks[questionIndex][0];
		return chosen === undefined ? 0 : Math.min(chosen, rows.length - 1);
	}

	function invalidate(): void {
		cachedWidth = undefined;
		cachedLines = undefined;
	}

	function refresh(): void {
		invalidate();
		tui.requestRender();
	}

	/** The single exit of the interaction: everything after it is ignored. */
	function finish(cancelled: boolean): void {
		if (closed) return;
		closed = true;
		done({
			cancelled,
			picks: cancelled ? [] : picks.map((row) => [...row]),
			customs: cancelled ? [] : [...customs],
		});
	}

	// ---------------------------------------------------------------- actions

	function openEditor(): void {
		mode = "custom";
		warning = "";
		editor.setText(customs[questionIndex]);
		editor.focused = focused;
		refresh();
	}

	/**
	 * Leave the editor with the written text ("" when the submit was empty: back to the options without
	 * answering). A non-empty text is the answer — it replaces the pick in `single` and is added to the
	 * picks in `multi`.
	 */
	function closeEditor(text: string): void {
		const question = currentQuestion();
		const index = customIndexOf(question);
		mode = "options";
		customs[questionIndex] = text;
		if (!text) picks[questionIndex] = picks[questionIndex].filter((pick) => pick !== index);
		else if (question.type === "single") picks[questionIndex] = selectSingle(index);
		else picks[questionIndex] = picks[questionIndex].includes(index) ? picks[questionIndex] : togglePick(picks[questionIndex], index);
		optionIndex = index;
		editor.focused = false;
		refresh();
	}

	function moveOption(delta: number): void {
		const rows = optionsFor(currentQuestion());
		optionIndex = Math.min(rows.length - 1, Math.max(0, optionIndex + delta));
		warning = "";
		refresh();
	}

	function moveQuestion(delta: number): void {
		if (questions.length < 2) return;
		questionIndex = (questionIndex + delta + questions.length) % questions.length;
		optionIndex = cursorForQuestion();
		warning = "";
		refresh();
	}

	/** Checkbox semantics on the current row; the free-form row is where the editor opens. */
	function toggleRow(): void {
		const question = currentQuestion();
		if (!isCustomRow()) {
			if (question.type !== "multi") return; // a radio row has no tick to flip
			picks[questionIndex] = togglePick(picks[questionIndex], optionIndex);
			warning = "";
			refresh();
			return;
		}
		const index = customIndexOf(question);
		if (question.type === "single") {
			openEditor(); // the written answer is edited, never ticked
			return;
		}
		if (picks[questionIndex].includes(index)) {
			picks[questionIndex] = togglePick(picks[questionIndex], index);
			customs[questionIndex] = "";
			warning = "";
			refresh();
			return;
		}
		picks[questionIndex] = togglePick(picks[questionIndex], index);
		openEditor();
	}

	/**
	 * Confirm: an empty free-form row opens the editor, anything else moves on. Enter on a free-form row
	 * that already holds text continues instead of reopening, so a written answer is never a dead end.
	 */
	function confirmRow(): void {
		const question = currentQuestion();
		if (isCustomRow() && !customs[questionIndex]) {
			openEditor();
			return;
		}
		if (question.type === "single" && !isCustomRow()) {
			picks[questionIndex] = selectSingle(optionIndex);
			// A radio pick replaces the written answer: only one of the two can be the answer.
			customs[questionIndex] = "";
		}
		advance();
	}

	function advance(): void {
		if (questionIndex < questions.length - 1) {
			questionIndex++;
			optionIndex = cursorForQuestion();
			warning = "";
			refresh();
			return;
		}
		submit();
	}

	/** Submit needs an answer on the last question; without one the hint says what to press. */
	function submit(): void {
		if (isAnswered(picks[questionIndex], customs[questionIndex])) {
			finish(false);
			return;
		}
		warning =
			currentQuestion().type === "multi"
				? "Tick at least one option with space, or write your own answer."
				: "Move to an option with the arrows, or write your own answer.";
		refresh();
	}

	editor.onSubmit = (value: string) => {
		closeEditor(value.trim());
	};

	function handleInput(data: string): void {
		if (closed) return;
		// Cancel wins over every mode: it is the only way out of a dialog the user did not expect.
		if (isCancelKey(data)) {
			finish(true);
			return;
		}
		if (mode === "custom") {
			editor.handleInput(data);
			refresh();
			return;
		}
		if (isUpKey(data)) return moveOption(-1);
		if (isDownKey(data)) return moveOption(1);
		if (isNextTabKey(data)) return moveQuestion(1);
		if (isPreviousTabKey(data)) return moveQuestion(-1);
		if (isConfirmKey(data)) return confirmRow();
		if (isToggleKey(data)) return toggleRow();
	}

	// ---------------------------------------------------------------- render

	function tabBar(): string {
		const tabs: string[] = [];
		for (let index = 0; index < questions.length; index++) {
			const answered = isAnswered(picks[index], customs[index]);
			const cell = ` ${answered ? "■" : "□"} ${sanitizeText(questions[index].header)} `;
			tabs.push(
				index === questionIndex
					? theme.bg("selectedBg", theme.fg("text", cell))
					: theme.fg(answered ? "success" : "muted", `${cell} `),
			);
		}
		return tabs.join("");
	}

	function hintLine(): string {
		if (mode === "custom") return "Enter saves your answer • Esc closes the questions";
		const question = currentQuestion();
		const custom = isCustomRow();
		const written = custom && customs[questionIndex].length > 0;
		const parts = ["↑↓ move"];
		if (custom) {
			if (written) parts.push("Enter continues", "Space edits");
			else parts.push("Enter writes your own answer");
		} else {
			if (question.type === "multi") parts.push("Space ticks");
			parts.push("Enter continues");
		}
		if (questions.length > 1) parts.push("Tab/←→ questions");
		parts.push("Esc closes");
		return parts.join(" • ");
	}

	function draw(width: number): string[] {
		const lines: string[] = [];
		const question = currentQuestion();
		const rows = optionsFor(question);

		// Cell-aware helpers: a prefix is measured, never counted, and continuations keep its width.
		const addWrapped = (text: string) => {
			lines.push(...wrapTextWithAnsi(text, width));
		};
		const addWithPrefix = (prefix: string, text: string) => {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= width) {
				addWrapped(truncateToWidth(`${prefix}${text}`, width));
				return;
			}
			const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
			const continuation = " ".repeat(prefixWidth);
			for (let index = 0; index < wrapped.length; index++) {
				lines.push(`${index === 0 ? prefix : continuation}${wrapped[index]}`);
			}
		};

		lines.push(theme.fg("accent", "─".repeat(width)));
		if (questions.length > 1) {
			addWithPrefix(" ", tabBar());
			lines.push("");
		}
		addWithPrefix(" ", theme.fg("text", sanitizeText(question.prompt)));
		lines.push("");

		const shown = Math.min(MAX_VISIBLE_OPTIONS, rows.length);
		const start = rows.length > shown ? Math.max(0, Math.min(optionIndex - shown + 1, rows.length - shown)) : 0;
		const above = start;
		const below = rows.length - (start + shown);
		if (above > 0) addWithPrefix("  ", theme.fg("dim", `↑ ${above} more`));

		for (let index = start; index < start + shown; index++) {
			const row: AskOption = rows[index];
			const checked = picks[questionIndex].includes(index);
			const cursor = index === optionIndex;
			const editingCustom = row.custom === true && mode === "custom";
			const marker = question.type === "multi" ? (checked ? "[x]" : "[ ]") : (checked ? "(•)" : "( )");
			const prefix = `${cursor ? theme.fg("accent", "> ") : "  "}${theme.fg(checked ? "success" : "muted", marker)} `;
			const label = `${index + 1}. ${sanitizeText(row.label)}${editingCustom ? " ✎" : ""}`;
			addWithPrefix(prefix, theme.fg(cursor || editingCustom ? "accent" : row.custom ? "muted" : "text", label));
			if (row.description) addWithPrefix(" ".repeat(DESCRIPTION_PREFIX_WIDTH), theme.fg("muted", sanitizeText(row.description)));
		}
		if (below > 0) addWithPrefix("  ", theme.fg("dim", `↓ ${below} more`));

		if (mode === "custom") {
			lines.push("");
			addWithPrefix(" ".repeat(ROW_PREFIX_WIDTH), theme.fg("muted", `${CUSTOM_LABEL}:`));
			const inner = Math.max(1, width - 2);
			for (const line of editor.render(inner)) {
				// The guard keeps an unexpectedly wide editor line from spilling over; the cursor marker
				// inside the line is zero-width, so only real overflow is cut.
				const candidate = ` ${line}`;
				lines.push(visibleWidth(candidate) <= width ? candidate : truncateToWidth(candidate, width));
			}
		}

		lines.push("");
		if (warning) addWithPrefix(" ", theme.fg("warning", warning));
		addWithPrefix(" ", theme.fg("dim", hintLine()));
		lines.push(theme.fg("accent", "─".repeat(width)));
		return lines;
	}

	function render(width: number): string[] {
		// Cache keyed by width: a resize is a different layout, not a cache hit.
		if (cachedLines && cachedWidth === width) return cachedLines;
		cachedWidth = width;
		cachedLines = draw(Math.max(1, width));
		return cachedLines;
	}

	function dispose(): void {
		closed = true;
		mode = "options";
		focused = false;
		editor.focused = false;
		editor.setText("");
		invalidate();
	}

	return {
		render,
		handleInput,
		invalidate,
		dispose,
		get focused(): boolean {
			return focused;
		},
		// Focus belongs to the inline editor while it is open; the TUI needs it there for the hardware
		// cursor and IME candidate window.
		set focused(value: boolean) {
			focused = value;
			editor.focused = value && mode === "custom";
		},
	};
}
