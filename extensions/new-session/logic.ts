/**
 * new-session — pure rules of the `/new-session` flow.
 *
 * No host package, no terminal, no file system and no model call in this module: it holds exactly the
 * rules `tests/run.mjs` can check offline. Dialogs, the model catalogue, the model call and the
 * session replacement live in `index.ts`.
 *
 * Invariants:
 * - `--model` and `--effort` are the only flags. A flag is removed by its text span, so the rest of the
 *   arguments keeps its spacing and stays the prompt of the new session;
 * - a picker row maps back to exactly one value: `* ` marks the row that is already chosen, and
 *   `rowValue()` removes the mark. A value can therefore never contain the mark itself;
 * - a model row is always `provider/id`: unique in the catalogue, copy-pasteable, and re-enterable as a
 *   search pattern;
 * - a trailing `:level` is read only when the whole text matches no model, because provider ids such as
 *   `qwen/qwen3-coder:exacto` contain colons;
 * - matching prefers an exact id over a substring, and a provider with credentials over one without;
 * - a model without credentials is reported as `no-auth` instead of started: `pi.setModel()` throws on
 *   it, and a half-started session is worse than no session;
 * - the effort list is the model's own supported levels. An unsupported level is clamped, never dropped;
 * - the hand-off mailbox is single-use, tied to the session file it replaced, and expires. A handoff that
 *   was never consumed must not survive to colour an unrelated session.
 */

/** Thinking levels Pi accepts, weakest first. Mirrors Pi's `EXTENDED_THINKING_LEVELS`. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Default prefix on a picker row: the value the flow already chose for you. */
export const DEFAULT_MARK = "* ";
/** Row that opens the free-text model search instead of naming a model. */
export const SEARCH_ROW = "Search all models by provider/id or name";

/** How many models the shortlist shows before the search row. */
export const SHORTLIST_LIMIT = 12;
/** How many models an ambiguous pattern may offer before asking the user to narrow it. */
export const AMBIGUOUS_LIMIT = 12;
/** How many models the recent-models file keeps. */
export const RECENT_LIMIT = 10;
/** A handoff older than this is stale: the switch that created it never happened. */
export const HANDOFF_MAX_AGE_MS = 20_000;
/** Budget of the conversation given to the handoff writer. */
export const GENERATION_LIMITS = { turns: 8, charsPerTurn: 4_000, totalChars: 14_000 };

/** One model as the flow sees it: enough to name it, resolve it and know whether it can run. */
export interface ModelRow {
	provider: string;
	id: string;
	/** Catalogue display name, used for substring matching only. */
	name?: string;
	/** Whether Pi has credentials for this model's provider. */
	authed: boolean;
}

/** A `{provider,id}` pair, as stored in the recent-models file or in the shortlist input. */
export interface ModelRef {
	provider: string;
	id: string;
}

export interface ParsedArgs {
	/** Raw `--model` value: `provider/id`, a bare id, a substring, optionally with `:level`. */
	modelPattern?: string;
	/** Raw `--effort` value, validated against `THINKING_LEVELS`. */
	effort?: ThinkingLevel;
	/** Text for the new session. Empty means "ask for the source". */
	prompt: string;
	/** Present when the arguments cannot be used; the flow then explains it instead of starting. */
	error?: string;
}

export type MatchStatus = "ok" | "ambiguous" | "no-auth" | "none";

export interface PatternResult {
	status: MatchStatus;
	/** Candidates: one for `ok`, `no-auth` and `none` (empty), several for `ambiguous`. */
	rows: ModelRow[];
	/** Level taken from a `:level` suffix, when one was read. */
	effort?: ThinkingLevel;
	/** What was searched, for the message the user reads. */
	pattern: string;
}

export type SourceKind = "verbatim" | "handoff" | "type";

export interface PromptSource {
	kind: SourceKind;
	label: string;
	/** Why the row is not selectable, when the flow disabled it. */
	unavailable?: string;
}

export interface SessionHandoff {
	provider: string;
	modelId: string;
	effort: ThinkingLevel;
	/** Session file the flow replaced; the handoff is only valid for the session that follows it. */
	previousSessionFile?: string;
	createdAt: number;
}

/** Minimal view of a session entry, so the pure rules never import Pi's entry types at runtime. */
export interface BranchEntryLike {
	type?: string;
	/** Message role for `type: "message"` entries. */
	message?: { role?: string; content?: unknown };
	/** Summary text for `type: "compaction"` entries. */
	summary?: string;
}

/** One conversation turn reduced to the text the handoff writer reads. */
export interface TurnText {
	role: "user" | "assistant" | "summary";
	text: string;
}

/** Mark the chosen row of a picker. */
export function markRow(value: string): string {
	return `${DEFAULT_MARK}${value}`;
}

/** Strip the mark from a picker row. Any other row is returned untouched. */
export function rowValue(row: string): string {
	return row.startsWith(DEFAULT_MARK) ? row.slice(DEFAULT_MARK.length) : row;
}

function keyOf(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

/** `provider/id` for a row, the string a picker shows and a pattern accepts. */
export function modelKey(row: ModelRow): string {
	return keyOf(row);
}

/**
 * Split the raw `/new-session` arguments.
 *
 * `--model <pattern>`, `--effort <level>` and their `=` forms are removed wherever they appear; what is
 * left is the prompt, spacing kept. A repeated flag is an error rather than a precedence rule: the flow
 * refuses to choose between two models the user named, because either choice starts a session nobody asked
 * for.
 */
export function parseArgs(raw: string): ParsedArgs {
	let rest = raw ?? "";
	let modelPattern: string | undefined;
	let effort: ThinkingLevel | undefined;
	const errors: string[] = [];

	for (const flag of ["model", "effort"] as const) {
		const pattern = newFlagPattern(flag);
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(rest)) !== null) {
			const value = match[1] ?? match[2];
			if (!value) {
				errors.push(`--${flag} needs a value`);
			} else if (flag === "model") {
				if (modelPattern !== undefined) errors.push("--model given twice");
				modelPattern = value;
			} else {
				const level = asThinkingLevel(value);
				if (!level) errors.push(`--effort must be one of ${THINKING_LEVELS.join(", ")}`);
				else if (effort !== undefined) errors.push("--effort given twice");
				else effort = level;
			}
			rest = `${rest.slice(0, match.index)}${rest.slice(match.index + match[0].length)}`;
			pattern.lastIndex = 0;
		}
	}

	const leftover = /--[^\s]+/.exec(rest);
	if (leftover) errors.push(`unknown flag ${leftover[0]}`);

	const prompt = rest.replace(/^\s+|\s+$/g, "");
	if (errors.length > 0) return { prompt, error: errors.join("; ") };
	return { modelPattern, effort, prompt };
}

/** Matches `--name value`, `--name=value` and a trailing `--name ` with no value. */
function newFlagPattern(flag: string): RegExp {
	return new RegExp(`--${flag}(?:=(\\S+)|\\s+(\\S+)|\\s*$)`, "g");
}

/** Case-insensitive thinking level, or undefined when the text names none. */
export function asThinkingLevel(value: string): ThinkingLevel | undefined {
	const lower = value.trim().toLowerCase();
	return THINKING_LEVELS.find((level) => level === lower);
}

/** Split a trailing `:level` off a pattern, keeping ids that legitimately contain a colon. */
export function splitLevelSuffix(pattern: string): { base: string; effort: ThinkingLevel } | undefined {
	const index = pattern.lastIndexOf(":");
	if (index <= 0) return undefined;
	const base = pattern.slice(0, index);
	const level = asThinkingLevel(pattern.slice(index + 1));
	return level ? { base, effort: level } : undefined;
}

function exactMatches(text: string, rows: ModelRow[]): ModelRow[] {
	const lower = text.toLowerCase();
	if (!lower) return [];
	if (lower.includes("/")) {
		const provider = lower.slice(0, lower.indexOf("/"));
		const id = lower.slice(provider.length + 1);
		return rows.filter((row) => row.provider.toLowerCase() === provider && row.id.toLowerCase() === id);
	}
	return rows.filter((row) => row.id.toLowerCase() === lower);
}

function substringMatches(text: string, rows: ModelRow[]): ModelRow[] {
	const lower = text.toLowerCase();
	return rows.filter((row) => {
		const key = keyOf(row).toLowerCase();
		return key.includes(lower) || (row.name ?? "").toLowerCase().includes(lower);
	});
}

/**
 * Resolve a typed model pattern against the catalogue.
 *
 * Exact `provider/id`, then exact bare id, then a substring of `provider/id` or of the display name. The
 * `:level` suffix is only tried after the whole text matches nothing, so an OpenRouter id that ends in
 * `:exacto` still resolves. Between several providers offering the same id, the one with credentials wins.
 */
export function matchPattern(pattern: string, rows: ModelRow[]): PatternResult {
	const text = (pattern ?? "").replace(/^\s+|\s+$/g, "");
	const base: PatternResult = { status: "none", rows: [], pattern: text };
	if (!text) return base;

	let found = exactMatches(text, rows);
	let effort: ThinkingLevel | undefined;
	if (found.length === 0) {
		const suffix = splitLevelSuffix(text);
		if (suffix) {
			found = exactMatches(suffix.base, rows);
			effort = suffix.effort;
		}
	}
	if (found.length === 0) found = substringMatches(effort ? text.slice(0, text.lastIndexOf(":")) : text, rows);
	if (found.length === 0) return { ...base, effort };

	const authed = found.filter((row) => row.authed);
	const pool = authed.length > 0 ? authed : found;
	if (pool.length > 1) {
		return { status: "ambiguous", rows: pool.slice(0, AMBIGUOUS_LIMIT), effort, pattern: text };
	}
	return { status: pool[0].authed ? "ok" : "no-auth", rows: [pool[0]], effort, pattern: text };
}

/**
 * Order the models the picker lists before offering a search.
 *
 * Current session model first (Enter then means "same model"), then the models this extension started
 * recently, then the session's scoped models, then the configured default, then any credentialed model
 * until the limit. References missing from the catalogue are dropped rather than invented.
 */
export function shortlist(input: {
	all: ModelRow[];
	current?: ModelRef;
	scoped?: ModelRef[];
	recent?: ModelRef[];
	defaultModel?: ModelRef;
	limit?: number;
}): ModelRow[] {
	const byKey = new Map<string, ModelRow>();
	for (const row of input.all) {
		if (!byKey.has(keyOf(row))) byKey.set(keyOf(row), row);
	}
	const out: ModelRow[] = [];
	const seen = new Set<string>();
	const take = (ref: ModelRef | undefined): void => {
		if (!ref) return;
		const row = byKey.get(keyOf(ref));
		if (!row || seen.has(keyOf(row))) return;
		seen.add(keyOf(row));
		out.push(row);
	};

	take(input.current);
	for (const ref of input.recent ?? []) take(ref);
	for (const ref of input.scoped ?? []) take(ref);
	take(input.defaultModel);

	const limit = input.limit ?? SHORTLIST_LIMIT;
	if (out.length < limit) {
		const usable = input.all
			.filter((row) => row.authed && !seen.has(keyOf(row)))
			.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
		for (const row of usable) {
			if (out.length >= limit) break;
			seen.add(keyOf(row));
			out.push(row);
		}
	}
	return out.slice(0, limit);
}

/** Rows for the model picker: the shortlist (first row marked) followed by the search row. */
export function modelPickerRows(list: ModelRow[]): string[] {
	if (list.length === 0) return [SEARCH_ROW];
	return [...list.map((row, index) => (index === 0 ? markRow(modelKey(row)) : modelKey(row))), SEARCH_ROW];
}

/** Rows for an ambiguous pattern: every candidate, unmarked, since none is the obvious answer. */
export function candidateRows(rows: ModelRow[]): string[] {
	return rows.map((row) => modelKey(row));
}

/**
 * Effort rows in canonical order, with the chosen level marked.
 *
 * `supported` comes from Pi (`getSupportedThinkingLevels`), so a model without reasoning yields only
 * `off` and the flow can skip the dialog instead of showing a one-row picker.
 */
export function effortRows(supported: readonly string[], chosen: string): string[] {
	const ordered = THINKING_LEVELS.filter((level) => supported.includes(level));
	const rows = (ordered.length > 0 ? ordered : supported).map((level) => (level === chosen ? markRow(level) : level));
	return rows;
}

/** The level the flow would pick when the user does not say. */
export function pickEffort(input: {
	supported: readonly ThinkingLevel[];
	requested?: ThinkingLevel;
	perModelSetting?: ThinkingLevel;
	sessionLevel?: ThinkingLevel;
}): ThinkingLevel {
	if (input.supported.length === 0) return "off";
	if (input.requested && input.supported.includes(input.requested)) return input.requested;
	if (input.perModelSetting && input.supported.includes(input.perModelSetting)) return input.perModelSetting;
	if (input.sessionLevel && input.supported.includes(input.sessionLevel)) return input.sessionLevel;
	if (input.supported.includes("medium")) return "medium";
	return input.supported[0];
}

/**
 * Nearest supported level for a requested one, used to explain a clamp instead of hiding it.
 *
 * Same direction as Pi's own `clampThinkingLevel`: the closest level at or above the request wins, and
 * only when nothing above it exists does the flow fall back to the closest one below.
 */
export function clampToSupported(requested: ThinkingLevel, supported: readonly ThinkingLevel[]): ThinkingLevel {
	if (supported.includes(requested)) return requested;
	const wanted = THINKING_LEVELS.indexOf(requested);
	if (wanted === -1) return supported[0] ?? "off";
	for (let index = wanted; index < THINKING_LEVELS.length; index++) {
		if (supported.includes(THINKING_LEVELS[index])) return THINKING_LEVELS[index];
	}
	for (let index = wanted - 1; index >= 0; index--) {
		if (supported.includes(THINKING_LEVELS[index])) return THINKING_LEVELS[index];
	}
	return supported[0] ?? "off";
}

/** Read the recent-models file. Anything unreadable yields an empty list: the flow never needs it. */
export function parseRecent(text: string | undefined): ModelRef[] {
	if (!text) return [];
	try {
		const parsed: unknown = JSON.parse(text);
		if (!Array.isArray(parsed)) return [];
		const refs: ModelRef[] = [];
		for (const entry of parsed) {
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as Record<string, unknown>;
			const provider = typeof record.provider === "string" ? record.provider : "";
			const id = typeof record.id === "string" ? record.id : "";
			if (provider && id) refs.push({ provider, id });
		}
		return refs;
	} catch {
		return [];
	}
}

/** Write the recent-models file: newest first, deduped, capped. */
export function formatRecent(chosen: ModelRef, previous: ModelRef[]): string {
	const out: ModelRef[] = [chosen, ...previous.filter((ref) => keyOf(ref) !== keyOf(chosen))].slice(0, RECENT_LIMIT);
	return `${JSON.stringify(out, null, "\t")}\n`;
}

/** Collapse a text to one preview line for a dialog title or a summary row. */
export function preview(text: string, maxChars = 120): string {
	const flat = (text ?? "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
	if (!flat) return "(empty)";
	if (flat.length <= maxChars) return flat;
	return `${flat.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** The block the user confirms: model, effort, where the prompt came from, and the prompt itself. */
export function reviewSummary(input: {
	model: ModelRef;
	effort: string;
	effortNote?: string;
	source: PromptSource;
	prompt: string;
	cwd: string;
}): string[] {
	const effortText = input.effortNote ? `${input.effort} (${input.effortNote})` : input.effort;
	const lines = [
		`model    ${keyOf(input.model)}`,
		`effort   ${effortText}`,
		`input    ${input.source.label} — ${input.prompt.length} chars`,
		`cwd      ${input.cwd}`,
		"",
		preview(input.prompt, 300),
		"",
		"The current session is saved and stays resumable with /resume.",
	];
	return input.prompt ? lines : [...lines, "Warning: the new session starts with an empty input."];
}

/** Reduce session entries to the text turns the handoff writer reads, newest first, then reversed. */
export function turnTexts(entries: readonly BranchEntryLike[], limits = GENERATION_LIMITS): TurnText[] {
	const picked: TurnText[] = [];
	for (let index = entries.length - 1; index >= 0 && picked.length < limits.turns; index--) {
		const entry = entries[index];
		if (entry?.type === "compaction" && typeof entry.summary === "string" && entry.summary) {
			picked.push({ role: "summary", text: cap(entry.summary, limits.charsPerTurn) });
			continue;
		}
		if (entry?.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = contentText(entry.message?.content);
		if (!text) continue;
		picked.push({ role, text: cap(text, limits.charsPerTurn) });
	}
	return picked.reverse();
}

/** Extract the plain text of a message content block, tolerating any shape. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content.replace(/^\s+|\s+$/g, "");
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("\n").replace(/^\s+|\s+$/g, "");
}

/** Newest assistant text in the branch, which is the output the new session should act on. */
export function lastAssistantText(entries: readonly BranchEntryLike[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = contentText(entry.message?.content);
		if (text) return text;
	}
	return undefined;
}

function cap(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/**
 * Fold the turns into one budgeted block.
 *
 * When it does not fit, the OLDEST turns are dropped: the newest turns are the ones the handoff writer
 * actually needs, and they sit at the end of the chronological list.
 */
export function serializeTurns(turns: readonly TurnText[], totalChars = GENERATION_LIMITS.totalChars): string {
	let kept = turns;
	while (kept.length > 1 && join(kept).length > totalChars) kept = kept.slice(1);
	return cap(join(kept), totalChars);
}

function join(turns: readonly TurnText[]): string {
	return turns.map((turn) => `${turn.role}: ${turn.text}`).join("\n\n");
}

/** The three ways the first input of the new session is produced. */
export const SOURCES: readonly PromptSource[] = [
	{ kind: "verbatim", label: "Last assistant message, as it is" },
	{ kind: "handoff", label: "Handoff prompt built from the last assistant message" },
	{ kind: "type", label: "Type it myself" },
];

/** Source rows in the order the flow shows them, with the default source marked. */
export function sourceRows(input: { hasAssistant: boolean; hasModel: boolean; chosen: SourceKind }): string[] {
	return SOURCES.map((source) => {
		let label = source.label;
		if (source.kind === "verbatim" && !input.hasAssistant) label = `${source.label} (no assistant message yet)`;
		if (source.kind === "handoff" && (!input.hasAssistant || !input.hasModel)) {
			label = `${source.label} (needs an assistant message and a model)`;
		}
		return source.kind === input.chosen ? markRow(label) : label;
	});
}

/** Find a source row the user picked. A disabled row never matches, so the flow keeps its fallback. */
export function sourceForRow(row: string, sources: readonly PromptSource[]): PromptSource | undefined {
	const value = rowValue(row);
	return sources.find((source) => source.label === value || source.label === value.replace(/\s+\(.*\)$/, ""));
}

/** The prompt the handoff writer must answer with. */
export const HANDOFF_SYSTEM_PROMPT = `You write the first prompt of a new Pi session. The new session has no memory of this conversation: it can only use what you give it.

Read the last assistant message in the conversation. It is the plan, task list, findings or question the next session must act on. Rewrite it as one prompt that tells a fresh session what to do, in English:

- state the task first, then the constraints and the file paths it names;
- keep every task, id, file path, symbol, command and number exactly as written. Never invent one;
- keep the order of a task list, and say which items are already done;
- include only the context the next session needs to start. Drop greetings, narration and restated questions;
- write the prompt only. No preamble, no code fence, no explanation of what you did.

If the last message contains nothing an agent could act on, write a prompt that asks the new session to continue the last unfinished step of that work.`;

/** Build the user message for one handoff generation call. */
export function buildHandoffRequest(turns: readonly TurnText[], lastAssistant: string, limits = GENERATION_LIMITS): string {
	const conversation = serializeTurns(turns, limits.totalChars);
	return [
		"## Conversation so far",
		"",
		conversation,
		"",
		"## Last assistant message (the work to hand off)",
		"",
		cap(lastAssistant, limits.charsPerTurn * 2),
		"",
		"## Task",
		"",
		"Write the first prompt of the new session.",
	].join("\n");
}

/**
 * Consume the hand-off mailbox.
 *
 * A handoff is read only by the session that immediately follows the one that wrote it: the reason must
 * be `new`, the previous session file must be the one it names, and it must be younger than the switch
 * that could have created it. A stale entry is dropped instead of kept, so a cancelled switch cannot
 * leak its model choice into a later, unrelated session.
 */
export function takeHandoff(
	mailbox: { current?: SessionHandoff },
	event: { reason?: string; previousSessionFile?: string },
	now: number,
): SessionHandoff | undefined {
	const handoff = mailbox.current;
	if (!handoff) return undefined;
	if (now - handoff.createdAt > HANDOFF_MAX_AGE_MS) {
		mailbox.current = undefined;
		return undefined;
	}
	if (event.reason !== "new") return undefined;
	if (handoff.previousSessionFile && event.previousSessionFile !== handoff.previousSessionFile) return undefined;
	mailbox.current = undefined;
	return handoff;
}
