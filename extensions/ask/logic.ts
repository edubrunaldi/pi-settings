/**
 * ask — pure data rules of the interactive question picker.
 *
 * No host package and no terminal in this module: it holds exactly the rules that can be checked
 * offline in `tests/run.mjs`. Keyboard, focus and layout state belong to `questionnaire.ts`, and the
 * tool contract to `index.ts`.
 *
 * Invariants:
 * - one call carries 1 to 4 questions, each with 2 to 8 declared options;
 * - the free-form option is ALWAYS last and can never be turned off: its index is `options.length`;
 * - `single` holds exactly one pick, `multi` holds sorted and unique picks;
 * - a free-form answer without text is not an answer.
 */

/** Highest number of questions in a single `ask` call. */
export const MAX_QUESTIONS = 4;
/** Fewest declared options a question can be asked with. */
export const MIN_OPTIONS = 2;
/** Most declared options a question can be asked with (the free-form option comes on top). */
export const MAX_OPTIONS = 8;
/** Label of the option that opens the inline text editor. Always the last row. */
export const CUSTOM_LABEL = "Your own answer";
/** Model-facing notice when the user closed the picker without answering. */
export const CANCELLED_TEXT =
	"The user closed the questions without answering. Do not invent an answer: continue with what you " +
	"already know, or ask again later with the ask tool.";
/** Placeholder for a question the user walked past without selecting anything. */
export const NO_SELECTION_TEXT = "(no selection)";

export type AskQuestionType = "single" | "multi";
export type AskCancelReason = "cancelled" | "ui_unavailable";

/** One renderable choice: a declared option, or the appended free-form option. */
export interface AskOption {
	label: string;
	description?: string;
	/** True only on the free-form option that `optionsFor()` appends. */
	custom?: boolean;
}

/** A validated question, as the picker renders it and as the tool result stores it. */
export interface AskQuestion {
	/** Stable snake_case id the model uses to map the answer back to its question. */
	id: string;
	/** Short tab label. */
	header: string;
	/** The sentence the user reads. */
	prompt: string;
	type: AskQuestionType;
	options: AskOption[];
}

/** What the user answered for one question. */
export interface AskAnswer {
	id: string;
	header: string;
	prompt: string;
	/** Indices into `optionsFor(question)`; a written answer uses `customIndexOf(question)`. */
	picks: number[];
	/** Labels of the picks, with the written text last when there is one. */
	labels: string[];
	/** Free-form text, when the user wrote one. */
	custom?: string;
}

/** Tool `details`: enough to rebuild the result display after a session resume. */
export interface AskDetails {
	cancelled: boolean;
	reason?: AskCancelReason;
	questions: AskQuestion[];
	answers?: AskAnswer[];
}

export type NormalizeResult = { ok: true; questions: AskQuestion[] } | { ok: false; error: string };

const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const LINE_BREAKS = /[\r\n\u0085\u2028\u2029]+/g;
const TABS = /[\t\u000b\u000c\u00a0]+/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const SPACES = / {2,}/g;

/**
 * Turn model-authored text into safe display text: ANSI escapes and control characters removed, line
 * breaks folded into spaces. The stored value stays raw; only what reaches the screen or the model
 * goes through here.
 */
export function sanitizeText(value: string): string {
	if (!value) return "";
	return value
		.replace(ANSI_SEQUENCE, "")
		.replace(LINE_BREAKS, " ")
		.replace(TABS, " ")
		.replace(CONTROL_CHARS, "")
		.replace(SPACES, " ")
		.trim();
}

/**
 * Validate and normalize the raw tool params. Errors name the violated limit so the model can fix the
 * call instead of guessing.
 */
export function normalizeQuestions(input: unknown): NormalizeResult {
	const raw = asRecord(input)?.questions;
	if (!Array.isArray(raw)) {
		return { ok: false, error: `questions must be an array of 1 to ${MAX_QUESTIONS} entries` };
	}
	if (raw.length < 1 || raw.length > MAX_QUESTIONS) {
		return { ok: false, error: `questions must hold 1 to ${MAX_QUESTIONS} entries (got ${raw.length})` };
	}

	const questions: AskQuestion[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < raw.length; index++) {
		const result = normalizeQuestion(raw[index], index);
		if (!result.ok) return { ok: false, error: result.error };
		if (seen.has(result.question.id)) {
			return { ok: false, error: `question ids must be unique ("${result.question.id}" appears twice)` };
		}
		seen.add(result.question.id);
		questions.push(result.question);
	}
	return { ok: true, questions };
}

type QuestionResult = { ok: true; question: AskQuestion } | { ok: false; error: string };

function normalizeQuestion(raw: unknown, index: number): QuestionResult {
	const source = asRecord(raw);
	const where = `question ${index + 1}`;
	if (!source) return { ok: false, error: `${where} must be an object` };

	const id = requiredText(source.id);
	if (!id) return { ok: false, error: `${where}: id must be a non-empty string` };
	const at = `question "${id}"`;

	const header = requiredText(source.header);
	if (!header) return { ok: false, error: `${at}: header must be a non-empty string` };
	const prompt = requiredText(source.prompt);
	if (!prompt) return { ok: false, error: `${at}: prompt must be a non-empty string` };
	if (source.type !== undefined && source.type !== "single" && source.type !== "multi") {
		return { ok: false, error: `${at}: type must be "single" or "multi" (got ${JSON.stringify(source.type)})` };
	}

	const options = normalizeOptions(source.options, at);
	if (!options.ok) return { ok: false, error: options.error };
	return {
		ok: true,
		question: { id, header, prompt, type: source.type === "multi" ? "multi" : "single", options: options.options },
	};
}

type OptionsResult = { ok: true; options: AskOption[] } | { ok: false; error: string };

function normalizeOptions(raw: unknown, at: string): OptionsResult {
	if (!Array.isArray(raw)) return { ok: false, error: `${at}: options must be an array` };
	if (raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) {
		return { ok: false, error: `${at}: options must hold ${MIN_OPTIONS} to ${MAX_OPTIONS} entries (got ${raw.length})` };
	}

	const options: AskOption[] = [];
	for (let index = 0; index < raw.length; index++) {
		const source = asRecord(raw[index]);
		const where = `${at}: option ${index + 1}`;
		if (!source) return { ok: false, error: `${where} must be an object` };
		const label = requiredText(source.label);
		if (!label) return { ok: false, error: `${where} must have a non-empty label` };
		const description = typeof source.description === "string" ? source.description.trim() : undefined;
		options.push(description ? { label, description } : { label });
	}
	return { ok: true, options };
}

/** The declared options plus the free-form one, which is always last and never removable. */
export function optionsFor(question: AskQuestion): AskOption[] {
	return [...question.options, { label: CUSTOM_LABEL, custom: true }];
}

/** Index of the free-form option: one past the declared options. */
export function customIndexOf(question: AskQuestion): number {
	return question.options.length;
}

/** Checkbox semantics: add the index when absent, remove it when present, keep the picks sorted. */
export function togglePick(picks: readonly number[], index: number): number[] {
	const next = picks.includes(index) ? picks.filter((pick) => pick !== index) : [...picks, index];
	return [...next].sort((a, b) => a - b);
}

/** Radio semantics: exactly one index, none for a negative index. */
export function selectSingle(index: number): number[] {
	return index < 0 ? [] : [index];
}

/** Whether the current state of a question counts as an answer (the picker's confirm rule). */
export function isAnswered(picks: readonly number[], custom: string | undefined): boolean {
	return picks.length > 0 || (custom ?? "").trim().length > 0;
}

/**
 * Merge the picker state into answers. A written answer replaces the pick in `single` and is appended
 * as an extra label in `multi`; an empty one is dropped.
 */
export function buildAnswers(
	questions: readonly AskQuestion[],
	picks: readonly (readonly number[])[],
	customs: readonly (string | undefined)[],
): AskAnswer[] {
	return questions.map((question, index) => answerFor(question, picks[index] ?? [], customs[index]));
}

function answerFor(question: AskQuestion, picked: readonly number[], rawCustom: string | undefined): AskAnswer {
	const base = { id: question.id, header: question.header, prompt: question.prompt };
	const declared = [...picked].filter((index) => index >= 0 && index < question.options.length).sort((a, b) => a - b);
	const labels = declared.map((index) => question.options[index].label);
	const custom = (rawCustom ?? "").trim();
	if (!custom) return { ...base, picks: declared, labels };
	if (question.type === "single") {
		return { ...base, picks: [customIndexOf(question)], labels: [custom], custom };
	}
	return { ...base, picks: [...declared, customIndexOf(question)], labels: [...labels, custom], custom };
}

/** The model-facing text of an answered or cancelled picker. */
export function formatAnswerText(details: AskDetails): string {
	const answers = details.answers ?? [];
	if (details.cancelled || answers.length === 0) return CANCELLED_TEXT;

	const lines = answers.map((answer, index) => {
		const question = details.questions.find((candidate) => candidate.id === answer.id);
		const kind = question?.type === "multi" ? "checkbox" : "radio";
		const labels = answer.labels.slice();
		// buildAnswers() always keeps the written text last, so dropping it leaves the declared picks.
		if (answer.custom) labels.pop();
		const parts = labels.map((label) => `"${sanitizeText(label)}"`);
		if (answer.custom) parts.push(`wrote: "${sanitizeText(answer.custom)}"`);
		return `${index + 1}. ${sanitizeText(answer.header)} (${kind}): ${parts.length ? parts.join("; ") : NO_SELECTION_TEXT}`;
	});
	const count = `User answered ${answers.length} question${answers.length === 1 ? "" : "s"}:`;
	return [count, ...lines].join("\n");
}

/**
 * The degrade path for modes with no terminal UI (rpc, json, print, subagent runs): the model gets the
 * questions back and asks them in prose, so nothing is invented.
 */
export function unavailableText(mode: string, questions: readonly AskQuestion[]): string {
	const lines = questions.map((question) => {
		const labels = [...question.options.map((option) => sanitizeText(option.label)), CUSTOM_LABEL].join(" | ");
		return `- ${question.id} (${question.type}): ${sanitizeText(question.prompt)}\n  options: ${labels}`;
	});
	return [
		`The interactive question picker is not available in ${mode} mode, so nothing was answered.`,
		"Ask these questions in your reply instead, in prose:",
		...lines,
	].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function requiredText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}
