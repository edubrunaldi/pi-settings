/**
 * ask — interactive question picker, callable by the model.
 *
 * The user answers with the keyboard in the editor area instead of the model writing questions into
 * its reply. Invariants:
 *
 * - `executionMode: "sequential"`: the whole tool batch is serialized, so no other dialog (the
 *   `plan_advance` confirmation, a second `ask`) can race with the open picker;
 * - always active. This is the deliberate exception to the repo rule that an off-feature tool stays out
 *   of the tool list: a question can be needed in any phase of any workflow, and `plan.ts` never removes
 *   tools it did not add (`syncToolActivation` only touches `PLAN_TOOLS`);
 * - headless degrades, never fails: without a terminal UI the model is told to ask in prose, so a print,
 *   json, rpc or subagent run does not lose the turn;
 * - the picker resolves exactly once — through its own `done`, or as cancelled when the run aborts — so
 *   no dialog outlives the tool call;
 * - convention, not enforcement: every question's first option is the recommended one and says so in
 *   its label (`(recommended)` / `(recomendado)`). Stated in the tool description, the prompt
 *   guidelines and the option schema, because the picker itself is neutral about ordering.
 *
 * Layout, keys and focus live in `questionnaire.ts` (loaded only when a picker is actually opened, so
 * the TUI module graph stays out of every other mode); the checkable data rules live in `logic.ts`.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CUSTOM_LABEL,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	buildAnswers,
	formatAnswerText,
	normalizeQuestions,
	sanitizeText,
	unavailableText,
	type AskDetails,
	type AskQuestion,
} from "./logic.ts";
import type { PickerResult } from "./questionnaire.ts";

const OPTION_PARAMS = Type.Object({
	label: Type.String({
		description:
			"User-facing label, 1 to 5 words. The first option's label ends with `(recommended)` — `(recomendado)` in Portuguese.",
	}),
	description: Type.Optional(
		Type.String({ description: "One sentence on what this option costs or implies." }),
	),
});

const QUESTION_PARAMS = Type.Object({
	id: Type.String({ description: "Stable snake_case identifier the answer is mapped back to." }),
	header: Type.String({ description: "Short tab label, about 12 characters." }),
	prompt: Type.String({ description: "The question the user reads, one sentence." }),
	type: Type.Optional(
		StringEnum(["single", "multi"] as const, {
			description: '"single" is a radio choice (default), "multi" allows several ticks.',
		}),
	),
	options: Type.Array(OPTION_PARAMS, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description:
			"Ordered by recommendation: the first option is the one you recommend and its label ends with " +
			"`(recommended)` — `(recomendado)` in Portuguese. " +
			`The free-form "${CUSTOM_LABEL}" option is added by the picker; never list it yourself.`
	}),
});

const ASK_PARAMS = Type.Object({
	questions: Type.Array(QUESTION_PARAMS, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: "The questions to ask in one screen (1 to 4).",
	}),
});

/** Cancelled result handed to the picker when the run goes away while it is open. */
const ABANDONED: PickerResult = { cancelled: true, picks: [], customs: [] };

export default function ask(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the user one or more multiple-choice questions in an interactive picker. " +
			"Use it instead of writing questions in your reply whenever you need a decision, a preference, " +
			"or missing information. Always put your recommended option first, marked `(recommended)` — " +
			"`(recomendado)` in Portuguese. Every question also offers a free-form answer.",
		promptSnippet:
			"Ask the user multiple-choice questions in an interactive picker (radio, checkbox, or free-form).",
		promptGuidelines: [
			"Never ask the user a question in prose: call `ask` and batch every question you need in one call.",
			"Use `ask` before guessing: when a request hides an unmade decision, ask instead of picking a default.",
			"Give each `ask` question 2 to 8 concrete options; the picker adds the free-form answer itself.",
			"In every question the recommended option comes first, with `(recommended)` written at the end of " +
				"its label (`(recomendado)` in Portuguese) — the user sees the default before reading the alternatives.",
		],
		parameters: ASK_PARAMS,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const normalized = normalizeQuestions(params);
			if (!normalized.ok) {
				// An observable failure: the model sees the violated limit and corrects the call.
				throw new Error(`ask: ${normalized.error}`);
			}
			const questions = normalized.questions;

			if (ctx.mode !== "tui" || !ctx.hasUI) {
				return {
					content: [{ type: "text", text: unavailableText(ctx.mode, questions) }],
					details: { cancelled: true, reason: "ui_unavailable", questions } as AskDetails,
				};
			}

			const result = await openPicker(ctx, questions, signal);
			// No result means the UI could not be opened at all: degrade the same way, do not fail the turn.
			if (!result) {
				return {
					content: [{ type: "text", text: unavailableText(ctx.mode, questions) }],
					details: { cancelled: true, reason: "ui_unavailable", questions } as AskDetails,
				};
			}

			const answers = result.cancelled ? undefined : buildAnswers(questions, result.picks, result.customs);
			const details: AskDetails = {
				cancelled: result.cancelled,
				reason: result.cancelled ? "cancelled" : undefined,
				questions,
				answers,
			};
			return { content: [{ type: "text", text: formatAnswerText(details) }], details };
		},

		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const headers = questions.map((question) => sanitizeText(question?.header ?? question?.id ?? "?")).join(", ");
			const count = questions.length === 1 ? "1 question" : `${questions.length} questions`;
			const text =
				theme.fg("toolTitle", theme.bold("ask ")) + theme.fg("muted", headers ? `${count} (${headers})` : count);
			return linesComponent(text, 2);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return linesComponent(first?.type === "text" ? first.text : "", MAX_QUESTIONS * 3);
			}
			if (details.cancelled) {
				const message =
					details.reason === "ui_unavailable"
						? "No interactive UI: answer these questions in your reply instead."
						: "Closed by the user without answering.";
				return linesComponent(theme.fg("warning", message), 2);
			}
			const lines = (details.answers ?? []).map((answer) => {
				const labels = answer.labels.slice();
				// buildAnswers() always keeps the written text last, so popping it leaves the declared picks.
				if (answer.custom) labels.pop();
				const chosen = labels.map((label) => `"${sanitizeText(label)}"`).join(", ");
				const written = answer.custom ? `${theme.fg("muted", "wrote ")}"${sanitizeText(answer.custom)}"` : "";
				const value = [chosen, written].filter(Boolean).join("; ") || theme.fg("dim", "no selection");
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", sanitizeText(answer.header))}: ${value}`;
			});
			return linesComponent(lines.join("\n"), MAX_QUESTIONS * 3);
		},
	});
}

/**
 * Open the picker and resolve it exactly once. `ctx.ui.custom()` only settles through the `done` it
 * hands to the component, so the run's abort signal drives the same latch: a session replacement or an
 * aborted run closes the dialog instead of leaving the terminal owned by a dead tool call.
 */
async function openPicker(
	ctx: ExtensionToolContext,
	questions: AskQuestion[],
	signal: AbortSignal | undefined,
): Promise<PickerResult | undefined> {
	if (signal?.aborted) return undefined;

	let finish: ((result: PickerResult) => void) | undefined;
	let pending: PickerResult | undefined;
	let settled = false;
	/** Resolve the interaction once, whether the answer comes from the component or from the abort. */
	const settle = (result: PickerResult): void => {
		if (settled) return;
		settled = true;
		if (finish) finish(result);
		else pending = result;
	};
	const onAbort = (): void => settle(ABANDONED);

	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await ctx.ui.custom<PickerResult>(async (tui, theme, keybindings, done) => {
			finish = done;
			if (pending) done(pending);
			const { createQuestionnaire } = await import("./questionnaire.ts");
			return createQuestionnaire({ questions, tui, theme, keybindings, done: settle });
		});
	} catch {
		// A component or host failure is not a reason to fail the turn: fall back to prose.
		return undefined;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Minimal component for the tool rows: pi's own visual-line limiter does the width work, so no terminal
 * measurement is reimplemented here and `@earendil-works/pi-tui` stays out of this module's imports.
 */
function linesComponent(text: string, maxLines: number): Component {
	return {
		render: (width: number): string[] =>
			truncateToVisualLines(text, maxLines, Math.max(1, width), 0, "start").visualLines,
		invalidate: () => {},
	};
}
