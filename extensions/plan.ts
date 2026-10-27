/**
 * plan — a collaborative planning workflow for Pi.
 *
 * Phases: off | investigate | summary | plan | ready
 *
 *   investigate  read-only exploration, alternating with questions to the user
 *        |  plan_title(<2-4 words>) names the plan (file + heading)
 *        |  plan_advance("summary")  ->  the user approves in a dialog
 *        v
 *   summary      the agent presents the agreed decisions and STOPS
 *        |  /plan approve            ->  the plan file is created with the model title
 *        v
 *   plan         agent writes the plan directly to the .md file; questions allowed
 *        |  /plan approve            ->  record the approval and offer a new session
 *        v
 *   ready        /plan approve can offer the new session again
 *
 * The plan file holds only the plan: its `# title` and the plan body. The summary,
 * the conversation and the flow metadata stay out of it.
 *
 * Transitions that represent a human decision are always confirmed by the user
 * (dialog or command), never inferred from the model's wording.
 *
 * Phase instructions ship as embedded defaults and can be overridden without
 * touching this file by placing markdown in:
 *   ~/.pi/agent/plan-flow/common.md
 *   ~/.pi/agent/plan-flow/investigate.md
 *   ~/.pi/agent/plan-flow/summary.md
 *   ~/.pi/agent/plan-flow/plan.md
 *   ~/.pi/agent/plan-flow/ready.md
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Phase = "off" | "investigate" | "summary" | "plan" | "ready";
type ThinkingLevelName = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

interface FlowState {
	phase: Phase;
	task: string;
	title?: string;
	planPath?: string;
	planStamp?: string;
	guard: boolean;
	approvedSummaryAt?: string;
	approvedPlanAt?: string;
	updatedAt: string;
}

/** Model choice for the implementation session; applied on its session_start (before the prompt is sent). */
interface PendingHandoff {
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	createdAt: string;
}

const PHASES: Phase[] = ["off", "investigate", "summary", "plan", "ready"];

const STATE_ENTRY = "plan-flow";
const PENDING_ENTRY = "plan-flow-handoff";
const APPLIED_ENTRY = "plan-flow-handoff-applied";
const PLAN_TOOLS = ["plan_advance", "plan_title"];
const PROMPT_SECTION = "plan_flow";
const STATUS_KEY = "plan-flow";
const WIDGET_KEY = "plan-flow";
const PLAN_PLACEHOLDER =
	"<!-- plan-flow: replace this comment with the complete executable plan. This file holds the plan and nothing else: no summary, no transcript, no metadata. -->";
const TITLE_PLACEHOLDER = "(untitled plan)";

const PHASE_LABEL: Record<Phase, string> = {
	off: "off",
	investigate: "investigation",
	summary: "summary (awaiting approval)",
	plan: "planning",
	ready: "plan approved",
};

const PHASE_STEP: Record<Phase, string> = {
	off: "",
	investigate: "[1/4]",
	summary: "[2/4]",
	plan: "[3/4]",
	ready: "[4/4]",
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const DEFAULT_INSTRUCTIONS: Record<Exclude<Phase, "off">, string> = {
	investigate: `
Current phase: INVESTIGATION.

Goal: understand the problem and the real state of the code, and decide with the user how to attack it. Do not implement yet.

- Investigate for real: read the relevant files (in full when needed), look for patterns the project already uses, and map dependencies, invariants and existing tests.
- Alternate between investigating and asking. Ask when the answer depends on a user decision, taste, priority or context; find on your own anything that lives in the code, config or history.
- Ask questions in small batches (1 to 4), each one motivated by something you found. Do not dump a long questionnaire.
- Separate explicitly: FACT (with file:symbol evidence), HYPOTHESIS (to confirm) and USER DECISION.
- Look for edge cases, risks, error paths, concurrency, data migration, and anything that must not break.
- Do not edit files or run state-changing commands in this phase.
- Once the problem is understood, call plan_title with a short title (2 to 4 words) that names the solution, not the sentence the user typed. That title becomes the plan file name and the plan heading. You can also pass it as the title parameter of plan_advance.
- When no open doubt would change the solution, say so in one sentence and call plan_advance with to="summary", stating in the reason what was decided. If something essential is still unclear, keep investigating or ask.`,

	summary: `
Current phase: SUMMARY AWAITING APPROVAL.

Present a complete, detailed summary of what was understood and decided. Then STOP: the plan is only generated after the user approves.

Summary structure:
1. Problem and goal (and what is explicitly not a goal).
2. Current state, with evidence (files, symbols, observed behavior).
3. Chosen approach and justification, including rejected alternatives and why.
4. User decisions, constraints and invariants that must keep holding.
5. Edge cases, risks and how they will be handled.
6. Observable success criteria.

Close with: "Approve this summary so I can open the plan file and write the plan there? Use /plan approve (or ask for changes)."

If the user asks for a change, revise the summary and stop again. If a knowledge gap appears that needs more investigation, call plan_advance with to="investigate". Do not write the plan in this phase. If the title you chose no longer describes the problem, call plan_title again before approval.`,

	plan: `
Current phase: PLANNING.

Turn the approved summary into an executable, self-contained plan: another session will run only from the plan file, without access to this conversation.

Write the plan DIRECTLY to this file: \${planPath}

The file already contains only its \`# <title>\` heading and a placeholder comment. Read it first, then replace the placeholder with the plan. Keep the file to the plan itself: no summary, no conversation transcript, no status lines, no metadata. The plan file is the source of truth: never paste the plan into the chat. After each update, reply with only the file path, a one-line status, and any open questions or what changed.

The title (first line) must be 2 to 4 words describing the solution. If what you found no longer fits it, call plan_title to rename both the heading and the file.

The plan must contain:
- Goal, scope and non-goals.
- Required context (files, components, contracts, invariants) with real paths.
- Numbered steps in executable order: what to change, why, the risk of the step, and how to check it.
- Edge cases and error handling, addressed step by step.
- Validation: exact test/check commands and verifiable acceptance criteria.
- Pending items and prerequisites.

Rules:
- Keep investigating and asking questions in this phase. If a doubt appears, investigate first; if it depends on the user, ask and wait instead of assuming. Questions and answers stay in the chat; the plan itself stays in the file.
- If an answer would change a decision from the approved summary, say so and ask for a new approval before continuing.
- Do not implement anything in this phase and do not modify source files: only the plan file is written here.
- If the user asks for a change, read the plan file first, edit it in place (preserving manual edits), and reply with a short summary of what changed. Do not reproduce the plan in the chat.
- Do not put the summary, the conversation or file metadata back into the file: only the plan and its title belong there.
- When the plan is finished, report the file path and say: "Plan ready in the file above. Review it and use /plan approve to approve it and choose whether to start a new implementation session."`,

	ready: `
Current phase: PLAN APPROVED.

The approved plan file is at \${planPath}. If the user declined the new session, /plan approve offers the handoff again.

In this phase do not keep exploring or reopen decisions that are already approved. If the user explicitly asks to implement here, do it (the phase does not block editing), but note that the workflow assumes a new session.`,
};

const COMMON_RULES = `General flow rules:
Phases are user-controlled. Never advance a phase on your own: transitions require user confirmation (the plan_advance dialog) or a /plan command.
Once the plan file exists, it is the source of truth: plan content lives in that file, never in a chat response.
Answer in the user's language. Cite evidence (file:symbol) instead of speaking in generalities.`;

function nowIso(): string {
	return new Date().toISOString();
}

function localStamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug || "plan";
}

/** Strip markdown/punctuation noise so a model-written title becomes a clean heading and file slug. */
function normalizeTitle(raw: string): string {
	return raw
		.replace(/^#+\s*/, "")
		.replace(/[`*_"'“”‘’]/g, "")
		.replace(/\s+/g, " ")
		.replace(/[.,;:!?]+$/g, "")
		.trim();
}

function titleWords(title: string): number {
	return title ? title.split(" ").filter(Boolean).length : 0;
}

/** Deterministic fallback when the model did not supply a title: the summary heading, else the task. */
function deriveTitle(text: string | undefined): string {
	const source = (text ?? "").trim();
	const heading = source.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? source.split("\n").find((line) => line.trim()) ?? "";
	const words = normalizeTitle(heading)
		.replace(/^(summary|resumo|plan|plano)\s*[:—–-]\s*/i, "")
		.split(" ")
		.filter(Boolean)
		.slice(0, 4);
	return words.join(" ") || TITLE_PLACEHOLDER;
}

export default function planFlow(pi: ExtensionAPI) {
	let state: FlowState = { phase: "off", task: "", guard: true, updatedAt: nowIso() };
	let overrides: Record<string, string> = {};

	// ---------------------------------------------------------------- state

	function persist(ctx: ExtensionContext) {
		state.updatedAt = nowIso();
		pi.appendEntry(STATE_ENTRY, state);
		syncToolActivation();
		renderStatus(ctx);
	}

	/**
	 * Keep the plan tools out of the model's tool list until a flow is actually running,
	 * so a user-level install does not change the prompt of unrelated sessions.
	 */
	function syncToolActivation() {
		const active = pi.getActiveTools();
		const wanted = state.phase !== "off";
		const missing = PLAN_TOOLS.filter((tool) => !active.includes(tool));
		const extra = active.filter((tool) => PLAN_TOOLS.includes(tool));
		if (wanted && missing.length === 0) return;
		if (!wanted && extra.length === 0) return;
		const next = wanted
			? [...active, ...missing]
			: active.filter((tool) => !PLAN_TOOLS.includes(tool));
		pi.setActiveTools(next);
	}

	function restoreFrom(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getBranch();
		let restored: FlowState | undefined;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as SessionEntry;
			if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
				restored = entry.data as FlowState;
				break;
			}
		}
		if (restored && PHASES.includes(restored.phase)) {
			state = { ...state, ...restored };
		}
	}

	function lastAssistantText(ctx: ExtensionContext): string | undefined {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as SessionEntry;
			if (entry.type !== "message") continue;
			const message = entry.message as { role?: string; content?: unknown };
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			const text = message.content
				.filter(
					(block): block is { type: "text"; text: string } =>
						typeof block === "object" &&
						block !== null &&
						(block as { type?: unknown }).type === "text" &&
						typeof (block as { text?: unknown }).text === "string",
				)
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
		return undefined;
	}

	// ---------------------------------------------------------------- instructions

	function loadOverrides() {
		const dir = join(getAgentDir(), "plan-flow");
		const next: Record<string, string> = {};
		if (!existsSync(dir)) {
			overrides = {};
			return;
		}
		for (const name of ["common", "investigate", "summary", "plan", "ready"]) {
			const file = join(dir, `${name}.md`);
			try {
				if (existsSync(file)) next[name] = readFileSync(file, "utf8").trim();
			} catch {
				// ignore unreadable override; fall back to embedded defaults
			}
		}
		overrides = next;
	}

	function instructionsFor(phase: Phase): string {
		if (phase === "off") return "";
		const defaults: Record<Exclude<Phase, "off">, string> = DEFAULT_INSTRUCTIONS;
		const body = (overrides[phase] ?? defaults[phase]).replace(
			"${planPath}",
			state.planPath ?? ".pi/plans/<timestamp>-<name>.md",
		);
		const common = overrides.common ? `General flow rules:\n${overrides.common}` : COMMON_RULES;
		return `${body}\n\n${common}`;
	}

	function promptSection(): string {
		const guard =
			state.guard && (state.phase === "investigate" || state.phase === "summary")
				? "Guard active: file edits are blocked in this phase."
				: "";
		return [
			`Plan flow — phase: ${PHASE_LABEL[state.phase]} ${PHASE_STEP[state.phase]}`.trim(),
			state.title ? `Plan title: ${state.title}` : "",
			state.task ? `Task: ${state.task}` : "",
			state.planPath ? `Plan file: ${displayPath(state.planPath)}` : "",
			guard,
			instructionsFor(state.phase),
		]
			.filter(Boolean)
			.join("\n\n");
	}

	// ---------------------------------------------------------------- UI

	function renderStatus(ctx: ExtensionContext) {
		if (state.phase === "off") {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, `plan:${state.phase}`);
		const task = state.task.length > 72 ? `${state.task.slice(0, 71)}…` : state.task || "(no task)";
		const title = state.title ? `title: ${state.title}` : "";
		const editing = state.guard && (state.phase === "investigate" || state.phase === "summary");
		const next =
			state.phase === "investigate"
				? "investigate ⇄ ask, then plan_advance(summary)"
				: state.phase === "summary"
					? "waiting for you: /plan approve or request changes"
					: state.phase === "plan"
						? "write the plan into the plan file; /plan approve approves the file"
						: "/plan approve offers the implementation session again";
		ctx.ui.setWidget(WIDGET_KEY,
			[
				"── plan-flow ─────────────────────────",
				`phase: ${PHASE_LABEL[state.phase]} ${PHASE_STEP[state.phase]}`.trimEnd(),
				title,
				`task: ${task}`,
				`editing: ${editing ? "blocked (read-only)" : "allowed"}`,
				state.planPath ? `plan: ${displayPath(state.planPath)}` : "",
				`next: ${next}`,
				"commands: /plan approve · /plan back · /plan stop",
				"───────────────────────────────────────────",
			].filter(Boolean),
		);
	}

	function say(ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error" = "info") {
		ctx.ui.notify(message, kind);
	}

	function displayPath(path: string): string {
		return path.replace(/\\/g, "/");
	}

	// ---------------------------------------------------------------- transitions

	function setPhase(next: Phase, ctx: ExtensionContext) {
		const previous = state.phase;
		state = { ...state, phase: next };
		persist(ctx);
		if (previous !== next) {
			say(ctx, `Plan flow: ${PHASE_LABEL[previous]} → ${PHASE_LABEL[next]}`);
		}
	}

	function draftPlanDocument(title: string): string {
		return [`# ${title}`, "", PLAN_PLACEHOLDER, ""].join("\n");
	}

	function planStampOf(path: string): string | undefined {
		return basename(path).match(/^(\d{8}-\d{6})-/)?.[1];
	}

	function writePlanFile(ctx: ExtensionContext, title: string): string {
		const dir = join(ctx.cwd, ".pi", "plans");
		const stamp = localStamp(new Date());
		const path = join(dir, `${stamp}-${slugify(title)}.md`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, draftPlanDocument(title), "utf8");
		state.planPath = path;
		state.planStamp = stamp;
		return path;
	}

	function withHeading(body: string, title: string): string {
		const heading = `# ${title}`;
		if (/^#\s+/m.test(body)) return body.replace(/^#\s+.*$/m, heading);
		return `${heading}\n\n${body.replace(/^\n+/, "")}`;
	}

	/**
	 * Set the short, model-chosen title. When the plan file already exists, rewrite its
	 * heading and rename it, keeping the creation timestamp prefix.
	 */
	function applyTitle(title: string): string | undefined {
		state.title = title;
		const path = state.planPath;
		if (!path || !existsSync(path)) return path;

		writeFileSync(path, withHeading(readFileSync(path, "utf8"), title), "utf8");

		const stamp = state.planStamp ?? planStampOf(path) ?? localStamp(new Date());
		state.planStamp = stamp;
		const next = join(dirname(path), `${stamp}-${slugify(title)}.md`);
		if (next === path) return path;
		if (existsSync(next)) return path;
		renameSync(path, next);
		state.planPath = next;
		return next;
	}

	function ensurePlanDraft(ctx: ExtensionContext): string {
		const title = state.title ?? deriveTitle(state.task);
		state.title = title;
		if (state.planPath && existsSync(state.planPath)) {
			state.approvedPlanAt = undefined;
			return state.planPath;
		}
		return writePlanFile(ctx, title);
	}

	function planFileIssue(path: string | undefined): string | undefined {
		if (!path) return "No plan file is registered for this flow.";
		if (!existsSync(path)) return `Plan file not found: ${displayPath(path)}`;
		const body = readFileSync(path, "utf8");
		if (!body.trim()) return `Plan file is empty: ${displayPath(path)}`;
		if (body.includes(PLAN_PLACEHOLDER)) {
			return `The plan file still contains the draft placeholder: ${displayPath(path)}`;
		}
		const plan = body.replace(/^#\s+.*$/m, "").replace(/<!--[\s\S]*?-->/g, "").trim();
		if (!plan) return `The plan file has a title but no plan yet: ${displayPath(path)}`;
		return undefined;
	}

	function enterPlanning(ctx: ExtensionContext, summary?: string): string {
		if (!state.title) state.title = deriveTitle(summary ?? state.task);
		state.approvedSummaryAt = nowIso();
		const path = ensurePlanDraft(ctx);
		setPhase("plan", ctx);
		return path;
	}

	/**
	 * Deliver a prepared prompt as a real user message, so `/plan start ...` does not need a
	 * second Enter. Falls back to staging it in the editor when sending is not possible.
	 */
	function sendUserPrompt(ctx: ExtensionContext, text: string): void {
		if (ctx.hasUI && ctx.isIdle()) {
			try {
				pi.sendUserMessage(text);
				return;
			} catch {
				// fall back to the editor below
			}
		}
		ctx.ui.setEditorText(text);
	}

	// ---------------------------------------------------------------- handoff

	function handoffPrompt(ctx: ExtensionContext): string {
		const path = displayPath(relative(ctx.cwd, state.planPath!));
		return `Plan file: \`${path}\` Read this file first and treat it as the source of truth for implementation.`;
	}

	function modelOptions(ctx: ExtensionContext): { label: string; provider: string; id: string }[] {
		const seen = new Set<string>();
		const list: { label: string; provider: string; id: string }[] = [];
		for (const model of ctx.modelRegistry.getAvailable()) {
			const provider = (model as { provider?: string }).provider ?? "unknown";
			const id = (model as { id?: string }).id;
			if (!id) continue;
			const key = `${provider}/${id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			list.push({ label: key, provider, id });
		}
		return list;
	}

	async function runHandoff(ctx: ExtensionCommandContext) {
		if (!state.approvedPlanAt || !state.planPath) return;
		if (!ctx.hasUI) {
			say(ctx, `Plan saved to ${displayPath(state.planPath)}. Open a new session manually and use: ${handoffPrompt(ctx)}`, "warning");
			return;
		}

		const goNow = await ctx.ui.confirm(
			"Plan approved — prepare implementation",
			"Create a new session now to implement the saved plan?",
		);
		if (!goNow) {
			say(ctx, "Plan saved. Use /plan approve when you want to start the implementation session.");
			return;
		}

		const models = modelOptions(ctx);
		let chosenModel: { provider: string; id: string } | undefined;
		if (models.length > 1) {
			const current = ctx.model ? `${(ctx.model as { provider?: string }).provider}/${ctx.model.id}` : undefined;
			const ordered = current
				? [...models].sort((a, b) => (a.label === current ? -1 : b.label === current ? 1 : 0))
				: models;
			const picked = await ctx.ui.select("Model for the implementation session", ordered.map((m) => m.label));
			if (picked) {
				const found = ordered.find((m) => m.label === picked);
				if (found) chosenModel = { provider: found.provider, id: found.id };
			}
		}

		const pickedLevel = await ctx.ui.select("Thinking level (if the model supports it)", ["keep current", ...THINKING_LEVELS]);
		const thinkingLevel = pickedLevel && pickedLevel !== "keep current" ? pickedLevel : undefined;

		const suggestion = slugify(state.title ?? state.task).slice(0, 40);
		const nameInput = await ctx.ui.input(`Session name (Enter = ${suggestion})`, suggestion);
		const name = (nameInput && nameInput.trim()) || suggestion;
		const prompt = handoffPrompt(ctx);

		const parent = ctx.sessionManager.getSessionFile();
		const pending: PendingHandoff = {
			provider: chosenModel?.provider,
			modelId: chosenModel?.id,
			thinkingLevel,
			createdAt: nowIso(),
		};
		const result = await ctx.newSession({
			parentSession: parent,
			setup: async (sessionManager) => {
				sessionManager.appendSessionInfo(name);
				sessionManager.appendCustomEntry(PENDING_ENTRY, pending);
				if (chosenModel) sessionManager.appendModelChange(chosenModel.provider, chosenModel.id);
				if (thinkingLevel) sessionManager.appendThinkingLevelChange(thinkingLevel);
			},
			// Run in the replacement session: send the handoff as a real message instead of
			// staging it in the editor, so the user does not have to press Enter again.
			withSession: async (next) => {
				try {
					await next.sendUserMessage(prompt);
				} catch {
					next.ui.setEditorText(prompt);
					say(next, "Implementation session prepared. Send the prompt in the editor.", "warning");
				}
			},
		});
		if (result.cancelled) {
			try {
				say(ctx, "New session creation was cancelled.", "info");
			} catch {
				// context already replaced; nothing to report
			}
		}
	}

	// ---------------------------------------------------------------- events

	pi.on("session_start", async (_event, ctx) => {
		loadOverrides();
		restoreFrom(ctx);
		syncToolActivation();
		renderStatus(ctx);

		// A replacement session created by /plan approve inherits the chosen model and
		// thinking level. It must be applied before withSession() sends the handoff prompt.
		let pending: PendingHandoff | undefined;
		let applied = false;
		for (const entry of ctx.sessionManager.getBranch() as SessionEntry[]) {
			if (entry.type !== "custom") continue;
			if (entry.customType === PENDING_ENTRY) pending = entry.data as PendingHandoff;
			if (entry.customType === APPLIED_ENTRY) applied = true;
		}
		if (pending && !applied) {
			if (pending.provider && pending.modelId) {
				const model = ctx.modelRegistry.find(pending.provider, pending.modelId);
				if (model) {
					const ok = await pi.setModel(model);
					if (!ok) say(ctx, `No credentials for ${pending.provider}/${pending.modelId}; use /model.`, "warning");
				}
			}
			if (pending.thinkingLevel) pi.setThinkingLevel(pending.thinkingLevel as ThinkingLevelName);
			pi.appendEntry(APPLIED_ENTRY, { appliedAt: nowIso() });
			// The implementation session starts without the planning flow.
			state = { phase: "off", task: "", guard: state.guard, updatedAt: nowIso() };
			persist(ctx);
		}
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		renderStatus(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		renderStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (state.phase === "off") {
			delete event.systemPromptOptions.sections[PROMPT_SECTION];
			return;
		}
		event.systemPromptOptions.sections[PROMPT_SECTION] = promptSection();
	});

	pi.on("tool_call", async (event) => {
		if (!state.guard) return;
		if (state.phase !== "investigate" && state.phase !== "summary") return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		return {
			block: true,
			reason:
				`Plan flow: we are in the ${PHASE_LABEL[state.phase]} phase, so edits are blocked. ` +
				"Keep investigating, ask the user what you need, and use plan_advance when you are ready.",
		};
	});

	// ---------------------------------------------------------------- tool

	pi.registerTool({
		name: "plan_advance",
		label: "Advance plan phase",
		description:
			"Ask the user to transition a plan flow phase (investigate -> summary -> plan). " +
			"The transition only happens if the user confirms in the dialog. Never approve a phase without this request.",
		promptSnippet: "Ask the user for the next plan flow phase.",
		parameters: Type.Object({
			to: StringEnum(["investigate", "summary", "plan"] as const, {
				description: "Phase you want to move to.",
			}),
			reason: Type.String({
				description: "One or two sentences saying what was decided and why this is the moment.",
			}),
			title: Type.Optional(
				Type.String({
					description:
					"Short plan title (2 to 4 words) naming the solution. Pass it when moving to summary; it becomes the plan file name and heading.",
				}),
			),
		}),
		exposure: "direct",
		defaultActive: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const to = params.to as Exclude<Phase, "off" | "ready">;
			if (state.phase === to) {
				return {
					content: [{ type: "text", text: `Already in the ${PHASE_LABEL[to]} phase.` }],
					details: { phase: state.phase },
				};
			}

			let requestedTitle: string | undefined;
			if (typeof params.title === "string" && params.title.trim()) {
				requestedTitle = normalizeTitle(params.title);
				const count = titleWords(requestedTitle);
				if (count < 2 || count > 4) {
					return {
						content: [
							{
								type: "text",
								text:
									`The title must be 2 to 4 words (got ${count}). Call plan_advance again with a shorter title ` +
									"or use plan_title.",
							},
						],
						details: { phase: state.phase },
					};
				}
			}

			if (to === "plan" && state.phase !== "summary") {
				return {
					content: [
						{
							type: "text",
							text:
								"Invalid transition: the plan may only start after the user approves the summary " +
								"(/plan approve).",
						},
					],
					details: { phase: state.phase },
				};
			}
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text:
								"No interactive UI to request confirmation. Tell the user to run /plan " +
								`with the needed subcommand (current phase: ${state.phase}).`,
						},
					],
					details: { phase: state.phase },
				};
			}
			const ok = await ctx.ui.confirm(
				`Advance to: ${PHASE_LABEL[to]}`,
				`${params.reason}\n\nAuthorize this transition?`,
			);
			if (!ok) {
				return {
					content: [
						{
							type: "text",
							text:
								`The user declined advancing to ${PHASE_LABEL[to]}. Ask what is missing and continue in ` +
								`${PHASE_LABEL[state.phase]}.`,
						},
					],
					details: { phase: state.phase, declined: true },
				};
			}
			let planPath: string | undefined;
			if (requestedTitle) applyTitle(requestedTitle);
			if (to === "plan") {
				planPath = enterPlanning(ctx, lastAssistantText(ctx));
			} else {
				setPhase(to, ctx);
			}
			return {
				content: [
					{
						type: "text",
						text:
							`Phase is now: ${PHASE_LABEL[to]}` +
							(state.title ? `\n\nPlan title: ${state.title}` : "") +
							(planPath ? `\n\nPlan file: ${displayPath(planPath)}` : "") +
							`\n\n${instructionsFor(to)}`,
					},
				],
				details: { phase: to, planPath, title: state.title },
			};
		},
	});

	pi.registerTool({
		name: "plan_title",
		label: "Name the plan",
		description:
		"Set the short plan title (2 to 4 words) that names the solution. It becomes the plan file name and the " +
		"plan heading; call it once the problem is understood, and again if the plan drifts from the title.",
		promptSnippet: "Give the plan a short 2-4 word title.",
		parameters: Type.Object({
			title: Type.String({
				description: "Short title naming the solution, 2 to 4 words. Not the sentence the user typed.",
			}),
		}),
		exposure: "direct",
		defaultActive: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const title = normalizeTitle(String(params.title ?? ""));
			const count = titleWords(title);
			if (count < 2 || count > 4) {
				return {
					content: [
						{
							type: "text",
							text: `The title must be 2 to 4 words (got ${count}). Call plan_title again with a shorter, concrete title.`,
						},
					],
					details: { title: state.title },
				};
			}
			const path = applyTitle(title);
			persist(ctx);
			return {
				content: [
					{
						type: "text",
						text:
							`Plan title is now: ${title}` +
							(path ? `\nPlan file: ${displayPath(path)}` : "\nThe plan file is created on /plan approve."),
					},
				],
				details: { title, planPath: path },
			};
		},
	});

	// ---------------------------------------------------------------- commands

	pi.registerCommand("plan", {
		description:
			"Plan flow: /plan [start|summary|approve|title|back|guard|stop|status] — " +
			"investigation → summary → plan → implementation session",
		handler: async (args, ctx) => {
			const raw = args.trim();
			const [sub = "status", ...rest] = raw.split(/\s+/);
			const argument = raw.slice(sub.length).trim();

			switch (sub.toLowerCase()) {
				case "start": {
					if (!argument) {
						say(ctx, "Usage: /plan start <describe the problem>", "error");
						return;
					}
					if (state.phase !== "off") {
						say(ctx, `A flow is already active (${PHASE_LABEL[state.phase]}). /plan start would restart it.`, "warning");
						if (ctx.hasUI) {
							const ok = await ctx.ui.confirm(
								"Restart the plan flow?",
								`Current phase: ${PHASE_LABEL[state.phase]}. Starting a new task discards this session's flow progress.`,
							);
							if (!ok) return;
						}
					}
					state = {
						phase: "investigate",
						task: argument,
						guard: state.guard,
						updatedAt: nowIso(),
					};
					persist(ctx);
					sendUserPrompt(
						ctx,
						`Problem: ${argument}\n\nInvestigate the current state and ask me whatever you need before proposing anything.`,
					);
					say(ctx, "Flow started in the investigation phase.");
					return;
				}

				case "summary": {
					if (state.phase === "off") {
						say(ctx, "Start with /plan start <problem>.", "warning");
						return;
					}
					setPhase("summary", ctx);
					return;
				}

				case "approve": {
					if (state.phase === "summary") {
						const summary = lastAssistantText(ctx);
						if (!summary) {
							say(ctx, "There is no summary to approve yet.", "error");
							return;
						}
						const path = enterPlanning(ctx, summary);
						sendUserPrompt(
							ctx,
							`Summary approved. Investigate any remaining doubts, and write the complete, self-contained plan directly to ${displayPath(path)}. The file must contain only the plan: no summary, no metadata. Ask me if a doubt needs my decision. Do not paste the plan in the chat; when it is ready, tell me the file path.`,
						);
						say(ctx, `Summary approved. Plan file: ${displayPath(path)}`);
						return;
					}
					if (state.phase === "plan") {
						const issue = planFileIssue(state.planPath);
						if (issue) {
							say(ctx, issue, "error");
							return;
						}
						state.approvedPlanAt = nowIso();
						setPhase("ready", ctx);
						say(ctx, `Plan APPROVED: ${displayPath(state.planPath!)}`);
						await runHandoff(ctx);
						return;
					}
					if (state.phase === "ready") {
						await runHandoff(ctx);
						return;
					}
					say(ctx, `Nothing to approve in the ${PHASE_LABEL[state.phase]} phase.`, "warning");
					return;
				}


				case "title": {
					if (state.phase === "off") {
						say(ctx, "Start with /plan start <problem>.", "warning");
						return;
					}
					const title = normalizeTitle(argument);
					const count = titleWords(title);
					if (count < 2 || count > 4) {
						say(ctx, "Usage: /plan title <2 to 4 words>", "error");
						return;
					}
					const path = applyTitle(title);
					persist(ctx);
					say(ctx, `Plan title: ${title}${path ? `\nfile: ${displayPath(path)}` : ""}`);
					return;
				}

				case "back": {
					const target = (rest[0] ?? "").toLowerCase();
					if (!["investigate", "summary", "plan"].includes(target)) {
						say(ctx, "Usage: /plan back <investigate|summary|plan>", "error");
						return;
					}
					if (target === "plan") ensurePlanDraft(ctx);
					setPhase(target as Phase, ctx);
					return;
				}

				case "guard": {
					const value = (rest[0] ?? "").toLowerCase();
					state.guard = value === "off" ? false : value === "on" ? true : !state.guard;
					persist(ctx);
					say(ctx, `Edit guard: ${state.guard ? "on (blocks edit/write in investigate and summary)" : "off"}`);
					return;
				}

				case "stop": {
					state = { phase: "off", task: "", guard: state.guard, updatedAt: nowIso() };
					persist(ctx);
					say(ctx, "Flow stopped.");
					return;
				}

				case "status":
				default: {
					const lines = [
						`Plan flow — phase: ${PHASE_LABEL[state.phase]} ${PHASE_STEP[state.phase]}`.trimEnd(),
						`title: ${state.title ?? "—"}`,
						`task: ${state.task || "(no task)"}`,
						`summary: ${state.approvedSummaryAt ? "approved" : "—"}`,
						`plan: ${state.approvedPlanAt ? "approved" : state.planPath ? "draft in file" : "—"}`,
						state.planPath ? `file: ${displayPath(state.planPath)}` : "file: —",
						`editing: ${state.guard ? "guarded in investigate/summary" : "free"}`,
					];
					say(ctx, lines.join("\n"));
					return;
				}
			}
		},
	});
}
