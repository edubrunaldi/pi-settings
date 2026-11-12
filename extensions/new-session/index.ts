/**
 * new-session — start a fresh session on a model and effort you pick, with the first input already sent.
 *
 * One command, `/new-session`, and no model-facing tool: the flow is a human decision, so it runs only
 * when a human asks. It replaces this session the way `/new` does (the current session stays on disk and
 * is resumable), chooses the model and the thinking level for the session that follows, decides what the
 * new session receives as its first input, and sends it.
 *
 * State machine, one pass per loop:
 *
 * ```text
 * model -> effort -> input -> review -+-> start
 *                                     +-> change model | effort | input -> back down the ladder
 *                                     +-> discard
 * ```
 *
 * Invariants:
 * - Pi has no per-new-session model API: `newSession()` inherits the configured defaults, and the `pi`
 *   handle of the session being replaced is stale afterwards. The chosen model and level therefore travel
 *   through a hand-off mailbox that the *replacement* session's own `session_start` reads. Pi emits
 *   `session_start` before `withSession()` runs, which is what lets the input go out on the right model;
 * - the mailbox lives on `globalThis`, not in module state: Pi's loader imports extensions with
 *   `moduleCache: false`, so this module is re-evaluated for the replacement session and module state
 *   would already be gone;
 * - only plain data crosses that boundary: provider, id, level, the file it replaced, a timestamp;
 * - a model the user named is never silently replaced. An unknown, ambiguous or credential-less pattern
 *   sends the flow back to the picker with the reason on screen;
 * - the flow asks only for what is missing: `--model`, a `name:level` pattern and `--effort` each skip
 *   their dialog, and the review screen still shows the whole result before anything is started;
 * - the input is editable before it is sent, including the text the flow generated itself;
 * - nothing happens until the switch succeeds: a cancelled switch leaves no message, no model change and
 *   no recent-models write;
 * - interactive only. Print, JSON and RPC hosts get a notification instead of a dialog that would hang.
 *
 * The pure rules — argument grammar, model matching, picker rows, the handoff prompt, the mailbox guard —
 * live in `logic.ts` and are covered by `tests/run.mjs`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	HANDOFF_SYSTEM_PROMPT,
	SOURCES,
	SEARCH_ROW,
	buildHandoffRequest,
	candidateRows,
	clampToSupported,
	contentText,
	effortRows,
	formatRecent,
	lastAssistantText,
	matchPattern,
	modelKey,
	modelPickerRows,
	parseArgs,
	parseRecent,
	pickEffort,
	reviewSummary,
	rowValue,
	shortlist,
	sourceForRow,
	sourceRows,
	takeHandoff,
	turnTexts,
	type BranchEntryLike,
	type ModelRef,
	type ModelRow,
	type PromptSource,
	type SessionHandoff,
	type ThinkingLevel,
	type TurnText,
} from "./logic.ts";

/** Source label for a prompt that came straight from the command arguments. */
const ARGS_SOURCE: PromptSource = { kind: "type", label: "the text after /new-session" };

/** Key of the cross-session mailbox. `globalThis` survives the module re-import, module state does not. */
const MAILBOX_KEY = Symbol.for("pi-settings.new-session.handoff");

interface Mailbox {
	current?: SessionHandoff;
}

/** A step returns undefined when the user closed its dialog, which ends the whole flow. */
type StepResult<T> = T | undefined;

type Stage = "model" | "effort" | "input" | "review";
type Decision = Stage | "start";

/** A model picked together with the level its pattern carried, so `opus:high` sets both at once. */
interface ModelChoice {
	ref: ModelRef;
	effort?: ThinkingLevel;
}

interface FlowState {
	model?: ModelRef;
	effort?: ThinkingLevel;
	/** Why the level differs from the one that was asked for. */
	effortNote?: string;
	source?: PromptSource;
	prompt?: string;
	/** The prompt came from the arguments, so the input step is skipped once. */
	fromArgs?: boolean;
	/** The user asked to change the input, so the argument text no longer counts. */
	inputDirty?: boolean;
	/** Level carried by a `model:level` pattern. Cleared when the model is chosen again. */
	patternEffort?: ThinkingLevel;
}

export default function newSession(pi: ExtensionAPI): void {
	// Runs in the session that was just created. Only the instance a `/new-session` switch produced finds
	// a mailbox entry; every other start is a no-op.
	pi.on("session_start", async (event, ctx) => {
		await applyHandoff(pi, ctx, event);
	});

	pi.registerCommand("new-session", {
		description: "New session on a chosen model and effort, sending the first input",
		getArgumentCompletions: argumentCompletions,
		handler: async (args, ctx) => {
			await runFlow(pi, ctx, String(args ?? ""));
		},
	});
}

// --------------------------------------------------------------------------- flow

async function runFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("new-session needs the interactive terminal. Use /new and /model there.", "error");
		return;
	}

	const parsed = parseArgs(rawArgs);
	if (parsed.error) {
		ctx.ui.notify(
			`new-session: ${parsed.error}. Usage: /new-session [--model <provider/id[:level]>] [--effort <level>] <text>`,
			"error",
		);
		return;
	}

	const catalogue = readCatalogue(ctx);
	if (catalogue.rows.length === 0) {
		ctx.ui.notify("new-session: the model catalogue is empty. Run /login first.", "error");
		return;
	}

	const state: FlowState = {};
	if (parsed.prompt) {
		state.prompt = parsed.prompt;
		state.fromArgs = true;
		state.source = ARGS_SOURCE;
	}
	const recent = readRecent();

	let stage: Stage = "model";
	for (;;) {
		if (stage === "model") {
			const chosen = await chooseModel(ctx, {
				catalogue,
				current: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				scoped: ctx.scopedModels.map((scoped) => ({ provider: scoped.model.provider, id: scoped.model.id })),
				recent,
				defaultModel: defaultRef(pi),
				initialPattern: state.model ? undefined : parsed.modelPattern,
			});
			if (!chosen) return cancelled(ctx);
			state.model = chosen.ref;
			state.patternEffort = chosen.effort;
			stage = "effort";
		}

		if (stage === "effort") {
			if (!(await chooseEffort(pi, ctx, state, catalogue, parsed.effort))) return cancelled(ctx);
			stage = "input";
		}

		if (stage === "input") {
			if (!(await chooseInput(ctx, state))) return cancelled(ctx);
			stage = "review";
		}

		const decision = await review(ctx, state);
		if (decision === "start") break;
		if (!decision) return cancelled(ctx);
		stage = decision;
		if (decision === "input") state.inputDirty = true;
	}

	await startSession(ctx, state);
}

function cancelled(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("new-session: closed. This session is untouched.", "info");
}

// --------------------------------------------------------------------------- catalogue

interface Catalogue {
	rows: ModelRow[];
	byKey: Map<string, Model<any>>;
}

function readCatalogue(ctx: ExtensionCommandContext): Catalogue {
	const rows: ModelRow[] = [];
	const byKey = new Map<string, Model<any>>();
	for (const model of ctx.modelRegistry.getAll()) {
		if (model.type && model.type !== "chat") continue;
		const key = `${model.provider}/${model.id}`;
		if (byKey.has(key)) continue;
		byKey.set(key, model);
		rows.push({
			provider: model.provider,
			id: model.id,
			name: model.name,
			authed: ctx.modelRegistry.hasConfiguredAuth(model),
		});
	}
	return { rows, byKey };
}

function defaultRef(pi: ExtensionAPI): ModelRef | undefined {
	const settings = pi.getSettings();
	if (!settings.defaultProvider || !settings.defaultModel) return undefined;
	return { provider: settings.defaultProvider, id: settings.defaultModel };
}

/** The per-model level saved with Ctrl+S in `/model`, which Pi applies to that model alone. */
function perModelEffort(pi: ExtensionAPI, key: string): ThinkingLevel | undefined {
	return pi.getSettings().modelThinkingLevels?.[key] as ThinkingLevel | undefined;
}

// --------------------------------------------------------------------------- steps

interface ModelStepInput {
	catalogue: Catalogue;
	current?: ModelRef;
	scoped: ModelRef[];
	recent: ModelRef[];
	defaultModel?: ModelRef;
	initialPattern?: string;
}

async function chooseModel(ctx: ExtensionCommandContext, input: ModelStepInput): Promise<StepResult<ModelChoice>> {
	const list = shortlist({
		all: input.catalogue.rows,
		current: input.current,
		scoped: input.scoped,
		recent: input.recent,
		defaultModel: input.defaultModel,
	});

	// A model named in the arguments is resolved before any dialog: whoever typed it should not have to
	// confirm it. A pattern that fails lands in the picker with the reason already on screen.
	if (input.initialPattern) {
		const resolved = await resolvePattern(ctx, input.initialPattern, input.catalogue);
		if (resolved) return resolved;
	}

	const title = `Model for the new session${input.current ? ` (this session is ${modelKey(input.current)})` : ""}`;
	for (;;) {
		const row = await ctx.ui.select(title, modelPickerRows(list));
		if (row === undefined) return undefined;
		const value = rowValue(row);
		if (value !== SEARCH_ROW) {
			const found = input.catalogue.byKey.get(value);
			if (found) return { ref: { provider: found.provider, id: found.id } };
			continue;
		}

		const typed = await ctx.ui.input("Model", "provider/id, an id, a word from the name, or name:level");
		if (!typed) continue;
		const resolved = await resolvePattern(ctx, typed, input.catalogue);
		if (resolved) return resolved;
	}
}

/** Resolve a typed pattern, explaining every refusal instead of guessing a model. */
async function resolvePattern(
	ctx: ExtensionCommandContext,
	pattern: string,
	catalogue: Catalogue,
): Promise<StepResult<ModelChoice>> {
	const result = matchPattern(pattern, catalogue.rows);
	if (result.status === "no-auth") {
		const row = result.rows[0];
		ctx.ui.notify(`new-session: no credentials for ${modelKey(row)}. Run /login ${row.provider}.`, "warning");
		return undefined;
	}
	if (result.status === "none") {
		ctx.ui.notify(`new-session: no model matches "${result.pattern}".`, "warning");
		return undefined;
	}
	if (result.status === "ambiguous") {
		const rows = candidateRows(result.rows);
		const picked = await ctx.ui.select(`${rows.length} models match "${result.pattern}", pick one`, rows);
		if (!picked) return undefined;
		const found = catalogue.byKey.get(picked);
		return found ? { ref: { provider: found.provider, id: found.id }, effort: result.effort } : undefined;
	}
	const row = result.rows[0];
	return { ref: { provider: row.provider, id: row.id }, effort: result.effort };
}

async function chooseEffort(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: FlowState,
	catalogue: Catalogue,
	requestedByFlag?: ThinkingLevel,
): Promise<StepResult<ThinkingLevel>> {
	const key = state.model ? modelKey(state.model) : "";
	const model = catalogue.byKey.get(key);
	if (!model) {
		ctx.ui.notify(`new-session: ${key || "the model"} is no longer in the catalogue.`, "error");
		return undefined;
	}

	const supported = getSupportedThinkingLevels(model) as ThinkingLevel[];
	const requested = requestedByFlag ?? state.patternEffort;
	if (requested && supported.length > 0 && !supported.includes(requested)) {
		const clamped = clampToSupported(requested, supported);
		state.effort = clamped;
		state.effortNote = `${requested} is not supported by this model`;
		return clamped;
	}

	state.effortNote = undefined;
	// A level the user named and this model supports needs no dialog: the review screen confirms it.
	if (requested) {
		state.effort = requested;
		return requested;
	}

	const chosen = pickEffort({ supported, perModelSetting: perModelEffort(pi, key), sessionLevel: ctx.thinkingLevel });
	if (supported.length <= 1) {
		// Nothing to choose on a model without reasoning.
		state.effort = chosen;
		return chosen;
	}

	const row = await ctx.ui.select(`Thinking level for ${key}`, effortRows(supported, chosen));
	if (row === undefined) return undefined;
	state.effort = rowValue(row) as ThinkingLevel;
	return state.effort;
}

async function chooseInput(ctx: ExtensionCommandContext, state: FlowState): Promise<StepResult<true>> {
	// Text typed in the arguments goes through once; after "change input" the flow asks like any other run.
	if (state.prompt && state.fromArgs && !state.inputDirty) return true;

	const branch = ctx.sessionManager.getBranch() as unknown as BranchEntryLike[];
	const lastAssistant = lastAssistantText(branch);
	const turns: TurnText[] = turnTexts(branch);

	for (;;) {
		const row = await ctx.ui.select(
			"What should the new session receive as its first input?",
			sourceRows({ hasAssistant: !!lastAssistant, hasModel: !!ctx.model, chosen: lastAssistant ? "verbatim" : "type" }),
		);
		if (row === undefined) return undefined;

		const source = sourceForRow(row, SOURCES);
		if (!source) continue;
		let text: string | undefined = source.kind === "type" ? undefined : lastAssistant;

		if (source.kind === "handoff") {
			if (!lastAssistant || !ctx.model) {
				ctx.ui.notify("new-session: that source needs an assistant message and a model here.", "warning");
				continue;
			}
			text = await generateHandoff(ctx, turns, lastAssistant);
			if (text === undefined) ctx.ui.notify("new-session: no handoff was written. Type or paste the input instead.", "info");
		}

		const prefill = state.inputDirty && state.prompt ? state.prompt : text ?? "";
		const edited = await ctx.ui.editor(
			source.kind === "handoff" ? "Handoff prompt, edit freely" : "First input of the new session, edit freely",
			prefill,
		);
		if (edited === undefined) return undefined;
		if (!edited.trim()) {
			ctx.ui.notify("new-session: the input is empty. Type something or close the flow.", "warning");
			continue;
		}
		state.prompt = edited;
		state.source = source;
		return true;
	}
}

/** Ask the current model to turn the last assistant message into a self-contained first prompt. */
async function generateHandoff(
	ctx: ExtensionCommandContext,
	turns: TurnText[],
	lastAssistant: string,
): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) return undefined;
	const request = buildHandoffRequest(turns, lastAssistant);

	return await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Writing the handoff prompt...");
		loader.onAbort = () => done(undefined);
		ctx.modelRegistry
			.complete(
				model,
				{
					systemPrompt: HANDOFF_SYSTEM_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: request }], timestamp: Date.now() }],
				},
				{ signal: loader.signal, cacheRetention: "none", sessionId: randomUUID() },
			)
			.then((response) => {
				done(response.stopReason === "aborted" ? undefined : contentText(response.content) || undefined);
			})
			.catch(() => done(undefined));
		return loader;
	});
}

async function review(ctx: ExtensionCommandContext, state: FlowState): Promise<StepResult<Decision>> {
	if (!state.model || !state.prompt) {
		ctx.ui.notify("new-session: the flow lost its own state. Close it and run /new-session again.", "error");
		return undefined;
	}
	const summary = reviewSummary({
		model: state.model,
		effort: state.effort ?? "off",
		effortNote: state.effortNote,
		source: state.source ?? SOURCES[0],
		prompt: state.prompt,
		cwd: ctx.cwd,
	}).join("\n");

	if (await ctx.ui.confirm("Start the new session?", summary)) return "start";
	const change = await ctx.ui.select("What should change?", [
		"model — keep going with another model",
		"effort — another thinking level",
		"input — another first prompt",
		"discard — leave this session alone",
	]);
	if (!change) return undefined;
	const value = rowValue(change).split(" ")[0];
	return value === "model" || value === "effort" || value === "input" ? value : undefined;
}

// --------------------------------------------------------------------------- switch

async function startSession(ctx: ExtensionCommandContext, state: FlowState): Promise<void> {
	const model = state.model;
	const prompt = state.prompt ?? "";
	if (!model || !prompt) return;
	const previousSessionFile = ctx.sessionManager.getSessionFile();

	// Plain data only: a freshly imported copy of this module reads it on the other side of the switch.
	mailbox().current = {
		provider: model.provider,
		modelId: model.id,
		effort: state.effort ?? "off",
		previousSessionFile,
		createdAt: Date.now(),
	};

	const result = await ctx.newSession({
		parentSession: previousSessionFile,
		withSession: async (fresh) => {
			try {
				await fresh.sendUserMessage(prompt);
			} catch (error) {
				fresh.ui.notify(`new-session: the session started, but the input was not sent: ${messageOf(error)}`, "error");
			}
			writeRecent(model);
		},
	});

	if (result.cancelled) {
		mailbox().current = undefined;
		ctx.ui.notify("new-session: another extension refused the switch. This session is untouched.", "info");
	}
}

/**
 * Apply the hand-off in the session `/new-session` created.
 *
 * `pi` here is that session's own handle, which is why this is the only place a per-session model can be
 * set: the replacement session inherits the configured defaults, and the handle of the session that was
 * replaced is stale. Pi emits `session_start` before `withSession()`, so the model is in place before the
 * first input is delivered.
 */
async function applyHandoff(pi: ExtensionAPI, ctx: ExtensionContext, event: SessionStartEvent): Promise<void> {
	const handoff = takeHandoff(mailbox(), { reason: event.reason, previousSessionFile: event.previousSessionFile }, Date.now());
	if (!handoff) return;

	const model = ctx.modelRegistry.find(handoff.provider, handoff.modelId);
	if (!model) {
		ctx.ui.notify(`new-session: ${handoff.provider}/${handoff.modelId} is no longer in the catalogue.`, "warning");
		return;
	}
	try {
		if (!(await pi.setModel(model))) {
			ctx.ui.notify(`new-session: no credentials for ${handoff.provider}/${handoff.modelId}.`, "warning");
			return;
		}
	} catch (error) {
		ctx.ui.notify(`new-session: could not select ${handoff.provider}/${handoff.modelId}: ${messageOf(error)}`, "warning");
		return;
	}
	// setModel() resolves a thinking level of its own, so the chosen one is applied after it.
	pi.setThinkingLevel(handoff.effort);
	ctx.ui.notify(`new-session: ${handoff.provider}/${handoff.modelId} on ${handoff.effort}.`, "info");
}

// --------------------------------------------------------------------------- mailbox and recents

function mailbox(): Mailbox {
	const store = globalThis as unknown as Record<symbol, Mailbox | undefined>;
	const existing = store[MAILBOX_KEY];
	if (existing) return existing;
	const created: Mailbox = {};
	store[MAILBOX_KEY] = created;
	return created;
}

function recentPath(): string {
	return join(getAgentDir(), "new-session", "recent-models.json");
}

function readRecent(): ModelRef[] {
	try {
		return parseRecent(readFileSync(recentPath(), "utf8"));
	} catch {
		return [];
	}
}

/** Newest first, capped. A failed write is not worth breaking a session switch over. */
function writeRecent(chosen: ModelRef): void {
	try {
		const path = recentPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, formatRecent(chosen, readRecent()), "utf8");
	} catch {
		// ignore: this file is a convenience list, never state the flow depends on
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function argumentCompletions(prefix: string): { value: string; label: string }[] | null {
	const text = prefix.replace(/^\s+/, "");
	if (text.includes("--model") || text.includes("--effort")) return null;
	const items = ["--model ", "--effort "].filter((flag) => flag.startsWith(text)).map((value) => ({ value, label: value.trimEnd() }));
	return items.length > 0 ? items : null;
}
