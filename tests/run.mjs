// Behavior tests for extensions/plan.ts — no model calls, no network.
// The host packages (typebox, @earendil-works/*) are stubbed in tests/stubs and copied into
// tests/node_modules on first run, so a fresh clone only needs `node tests/run.mjs`.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Stubs live at tests/stubs and are copied into <repo>/node_modules on first run, where both
// tests/ and extensions/ can resolve them (Node only walks up from the importing file).
const stubDir = fileURLToPath(new URL("./stubs", import.meta.url));
const stubTarget = fileURLToPath(new URL("../node_modules", import.meta.url));
if (!existsSync(join(stubTarget, "typebox"))) {
	cpSync(stubDir, stubTarget, { recursive: true });
}

const { default: factory } = await import("../extensions/plan.ts");

const cwd = mkdtempSync(join(tmpdir(), "piflow-"));
process.env.PI_AGENT_DIR_OVERRIDE = join(cwd, "agent");

const calls = [];
let activeBranch = null;
let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const handlersByName = new Map();
const commands = {};
const tools = {};

const pi = {
	on(event, handler) {
		if (!handlersByName.has(event)) handlersByName.set(event, []);
		handlersByName.get(event).push(handler);
		return () => {};
	},
	registerTool(tool) {
		tools[tool.name] = tool;
	},
	registerCommand(name, options) {
		commands[name] = options;
	},
	appendEntry(customType, data) {
		activeBranch.entries.push({ type: "custom", customType, data });
	},
	getActiveTools: () => [...activeTools],
	setActiveTools: (names) => {
		activeTools = [...names];
		calls.push(["setActiveTools", activeTools.join(",")]);
	},
	setModel: async (model) => {
		calls.push(["setModel", `${model.provider}/${model.id}`]);
		return true;
	},
	setThinkingLevel: (level) => calls.push(["setThinkingLevel", level]),
	getThinkingLevel: () => "high",
	sendUserMessage: (content) => calls.push(["sendUserMessage", content]),
};

function assistantMessage(text) {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}
function makeBranch(name) {
	return { name, file: join(cwd, "sessions", `${name}.jsonl`), entries: [] };
}

function makeCtx(branch, dialogs = {}) {
	return {
		cwd,
		mode: "tui",
		hasUI: true,
		model: { provider: "qwen-token-plan-individual", id: "qwen3.8-flash" },
		thinkingLevel: "high",
		isIdle: () => true,
		signal: undefined,
		abort() {},
		sessionManager: {
			getBranch: () => branch.entries,
			getSessionFile: () => branch.file,
			appendSessionInfo: (name) => {
				branch.entries.push({ type: "session_info", name });
				calls.push(["appendSessionInfo", name]);
				return "id";
			},
			appendCustomEntry: (customType, data) => {
				branch.entries.push({ type: "custom", customType, data });
				return "id";
			},
			appendModelChange: (provider, modelId) => {
				branch.entries.push({ type: "model_change", provider, modelId });
				return "id";
			},
			appendThinkingLevelChange: (thinkingLevel) => {
				branch.entries.push({ type: "thinking_level_change", thinkingLevel });
				return "id";
			},
		},
		modelRegistry: {
			getAvailable: () => [
				{ provider: "qwen-token-plan-individual", id: "qwen3.8-flash" },
				{ provider: "anthropic", id: "claude-sonnet-4-5" },
			],
			find: (provider, id) => ({ provider, id }),
		},
		newSession: async (options) => {
			const next = makeBranch("impl");
			const previous = activeBranch;
			activeBranch = next;
			await options.setup(makeCtx(next, dialogs).sessionManager);
			// Simulate the new session's extension instance starting.
			for (const handler of handlersByName.get("session_start") ?? []) {
				await handler({ type: "session_start" }, makeCtx(next, dialogs));
			}
			if (options.withSession) {
				const nextCtx = makeCtx(next, dialogs);
				nextCtx.sendUserMessage = async (content) => calls.push(["withSession.sendUserMessage", content]);
				await options.withSession(nextCtx);
			}
			activeBranch = previous;
			return { cancelled: false };
		},
		ui: {
			notify: (message, type) => calls.push(["notify", message, type]),
			setStatus: (key, value) => calls.push(["setStatus", value]),
			setWidget: (key, value) => calls.push(["setWidget", value ? value.length : null]),
			setEditorText: (text) => calls.push(["setEditorText", text]),
			confirm: async (title, message) => {
				calls.push(["confirm", title, message]);
				return dialogs.confirm ? dialogs.confirm(title, message) : true;
			},
			select: async (title, options) => {
				calls.push(["select", title, options]);
				return dialogs.select ? dialogs.select(title, options) : options[0];
			},
			input: async (title, placeholder) => {
				calls.push(["input", title, placeholder]);
				return dialogs.input ? dialogs.input(title, placeholder) : undefined;
			},
			theme: { fg: (_c, s) => s },
		},
	};
}

async function fire(event, payload, ctx) {
	for (const handler of handlersByName.get(event) ?? []) {
		await handler(payload, ctx);
	}
}

async function runCommand(args, ctx) {
	await commands.plan.handler(args, ctx);
}

function lastCall(name) {
	for (let i = calls.length - 1; i >= 0; i--) if (calls[i][0] === name) return calls[i];
	return undefined;
}

function clearCalls() {
	calls.length = 0;
}

factory(pi);
assert.ok(tools.plan_advance, "plan_advance registered");
assert.equal(tools.plan_advance.defaultActive, false, "tool starts inactive");
assert.ok(commands.plan, "/plan registered");
assert.doesNotMatch(commands.plan.description, /save|handoff/);

activeBranch = makeBranch("main");
const ctx = makeCtx(activeBranch);
await fire("session_start", { type: "session_start" }, ctx);
assert.deepEqual(lastCall("setStatus")[1], undefined, "status cleared while flow is off");
assert.ok(!activeTools.includes("plan_advance"), "plan_advance not declared while off");

// 1. start: the opening prompt is sent, so no second Enter is needed
await runCommand("start add retry to the OBS snapshot pipeline", ctx);
assert.equal(activeBranch.entries.at(-1).data.phase, "investigate");
assert.ok(activeTools.includes("plan_advance"), "plan_advance declared once the flow runs");
assert.ok(activeTools.includes("plan_title"), "plan_title declared once the flow runs");
assert.ok(lastCall("sendUserMessage")[1].startsWith("Problem: add retry"), "opening prompt sent directly");
assert.equal(calls.filter((c) => c[0] === "setEditorText").length, 0, "/plan start stages nothing");

// guard blocks edits while investigating
const guardHandler = handlersByName.get("tool_call")[0];
assert.equal(
	(await guardHandler({ type: "tool_call", toolCallId: "t1", toolName: "edit", input: {} }, ctx)).block,
	true,
	"edit blocked in investigation",
);
assert.equal(await guardHandler({ type: "tool_call", toolCallId: "t2", toolName: "read", input: {} }, ctx), undefined, "read allowed");

// phase instructions reach the system prompt as a section
const before = { type: "before_agent_start", systemPrompt: "base", systemPromptOptions: { sections: {} } };
await fire("before_agent_start", before, ctx);
assert.match(before.systemPromptOptions.sections.plan_flow, /Current phase: INVESTIGATION/);
assert.match(before.systemPromptOptions.sections.plan_flow, /Task: add retry/);

// a jump straight to planning is refused while still investigating
const badJump = await tools.plan_advance.execute("tc", { to: "plan", reason: "skip" }, undefined, undefined, ctx);
assert.match(badJump.content[0].text, /Invalid transition/);

// 2. investigate -> the model names the plan -> asks to move to summary
activeBranch.entries.push(assistantMessage("Found that obs_ingest has no timeout handling. Decided retry with backoff."));
const titleCall = await tools.plan_title.execute("tt", { title: "obs snapshot retry" }, undefined, undefined, ctx);
assert.match(titleCall.content[0].text, /Plan title is now: obs snapshot retry/);
assert.match(titleCall.content[0].text, /created on \/plan approve/, "no file before planning");
const tooLong = await tools.plan_title.execute("tt2", { title: "one two three four five" }, undefined, undefined, ctx);
assert.match(tooLong.content[0].text, /must be 2 to 4 words/, "long titles are refused");
assert.equal(activeBranch.entries.at(-1).data.title, "obs snapshot retry", "rejected title is not stored");
const advance = await tools.plan_advance.execute("tc", { to: "summary", reason: "No open doubt changes the solution." }, undefined, undefined, ctx);
assert.match(advance.content[0].text, /SUMMARY AWAITING APPROVAL/, "tool returns the new phase instructions");
assert.equal(activeBranch.entries.at(-1).data.phase, "summary");

// 3. summary presented, user approves -> the file is created with the model title only
activeBranch.entries.push(assistantMessage("SUMMARY\n1. problem: timeouts\n2. decision: exponential retry\n3. test: run_tests.py obs_ingest"));
clearCalls();
await runCommand("approve", ctx);
let planState = activeBranch.entries.at(-1).data;
assert.equal(planState.phase, "plan");
assert.equal(planState.title, "obs snapshot retry", "title survives the summary approval");
assert.equal(planState.summary, undefined, "the summary is not stored in the flow state");
let planPath = planState.planPath;
assert.ok(planPath && existsSync(planPath), `plan file exists at ${planPath}`);
assert.match(planPath, /\.pi([/\\])plans([/\\])\d{8}-\d{6}-obs-snapshot-retry\.md$/, "file name comes from the title");
let body = readFileSync(planPath, "utf8");
const draftLines = body.trim().split("\n");
assert.equal(draftLines[0], "# obs snapshot retry", "title is the first line");
assert.equal(draftLines.length, 3, "only the title, a blank line and the placeholder");
assert.match(draftLines[2], /^<!-- plan-flow:/);
assert.doesNotMatch(body, /Status: DRAFT|Flow phase|Approved summary|## Plan|Source session|Created:/);
assert.match(lastCall("notify")[1], /Plan file:/, "summary approval shows the plan file path");
const staged = lastCall("sendUserMessage")[1];
assert.match(staged, /write the complete, self-contained plan directly to/);
assert.match(staged, /only the plan: no summary, no metadata/);
assert.match(staged, /Do not paste the plan in the chat/);
assert.equal(calls.filter((c) => c[0] === "setEditorText").length, 0, "summary approval sends the kickoff prompt");

// the planning instructions point to the file and keep questions allowed
const duringPlan = { type: "before_agent_start", systemPrompt: "base", systemPromptOptions: { sections: {} } };
await fire("before_agent_start", duringPlan, ctx);
const planPrompt = duringPlan.systemPromptOptions.sections.plan_flow;
assert.match(planPrompt, /Current phase: PLANNING/);
assert.match(planPrompt, /Write the plan DIRECTLY to this file/);
assert.match(planPrompt, /Keep investigating and asking questions/);
assert.match(planPrompt, /never paste the plan into the chat/i);
assert.ok(planPrompt.includes(planPath.replace(/\\/g, "/")), "prompt carries the exact plan file path");

// guard no longer blocks writes while planning
assert.equal(await guardHandler({ type: "tool_call", toolCallId: "t3", toolName: "edit", input: {} }, ctx), undefined, "editing allowed in planning");

// approval refuses the untouched draft
clearCalls();
await runCommand("approve", ctx);
assert.equal(activeBranch.entries.at(-1).data.phase, "plan", "placeholder is not approvable");
assert.match(lastCall("notify")[1], /draft placeholder/);

// 4. the agent writes the plan into the file; approval reads the file, not the chat
body = body.replace(/<!-- plan-flow:[\s\S]*?-->/, "1. Wrap the snapshot in retry with backoff\n2. Quarantine after 3 failures\n3. Keep the user's manual note: retry cap is 3\n\nValidation: uv run python tools/run_tests.py obs_ingest");
writeFileSync(planPath, body, "utf8");
const editedBody = body;
activeBranch.entries.push(assistantMessage("Plan written to the file. Any doubt about the retry cap?"));

// a better title renames both the heading and the file
clearCalls();
await runCommand("title obs retry backoff", ctx);
planState = activeBranch.entries.at(-1).data;
assert.equal(planState.title, "obs retry backoff");
const renamedPath = planState.planPath;
assert.notEqual(renamedPath, planPath, "the file was renamed");
assert.match(renamedPath, /-obs-retry-backoff\.md$/);
assert.equal(existsSync(planPath), false, "the old file path is gone");
const renamedBody = readFileSync(renamedPath, "utf8");
assert.equal(renamedBody.trim().split("\n")[0], "# obs retry backoff", "the heading follows the title");
assert.match(renamedBody, /Wrap the snapshot in retry with backoff/, "rename preserves the plan body");
planPath = renamedPath;

clearCalls();
await runCommand("approve", makeCtx(activeBranch, { confirm: () => false }));
planState = activeBranch.entries.at(-1).data;
assert.equal(planState.phase, "ready");
assert.equal(planState.planPath, planPath, "approval keeps the same file");
assert.ok(planState.approvedPlanAt, "approval timestamp recorded");
const approvedBody = readFileSync(planPath, "utf8");
assert.equal(approvedBody, renamedBody, "approval never rewrites the plan file");
assert.doesNotMatch(approvedBody, /Status: APPROVED|Flow phase|## Approved summary|## Plan/);
assert.match(approvedBody, /Wrap the snapshot in retry with backoff/);
assert.match(approvedBody, /quarantine after 3 failures/i);
assert.match(approvedBody, /manual note: retry cap is 3/);
assert.doesNotMatch(approvedBody, /plan-flow: replace this comment/);
assert.doesNotMatch(approvedBody, /Plan written to the file/, "chat text is not copied into the plan");
assert.equal(calls.filter((c) => c[0] === "confirm").length, 1);
assert.equal(calls.filter((c) => c[0] === "setEditorText").length, 0, "declining does not stage an old prompt");

// 5. repeat approve -> new session without rewriting the plan
clearCalls();
let implBranch = null;
const handoffDialogs = {
	confirm: () => true,
	select: (title, options) => (title.includes("Model") ? "anthropic/claude-sonnet-4-5" : "high"),
	input: () => "",
};
const ctxForHandoff = makeCtx(activeBranch, handoffDialogs);
ctxForHandoff.newSession = async (options) => {
	const next = makeBranch("impl");
	const previous = activeBranch;
	activeBranch = next;
	await options.setup(makeCtx(next, handoffDialogs).sessionManager);
	for (const handler of handlersByName.get("session_start") ?? []) {
		await handler({ type: "session_start" }, makeCtx(next, handoffDialogs));
	}
	if (options.withSession) {
		const nextCtx = makeCtx(next, handoffDialogs);
		nextCtx.sendUserMessage = async (content) => calls.push(["withSession.sendUserMessage", content]);
		await options.withSession(nextCtx);
	}
	implBranch = next;
	activeBranch = previous;
	return { cancelled: false };
};
await runCommand("approve", ctxForHandoff);

assert.ok(implBranch, "new session created");
const expectedPrompt = `Plan file: \`.pi/plans/${planPath.split(/[/\\]/).at(-1)}\` Read this file first and treat it as the source of truth for implementation.`;
assert.equal(lastCall("withSession.sendUserMessage")[1], expectedPrompt, "handoff prompt is sent, not staged");
assert.equal(lastCall("setEditorText"), undefined, "nothing is staged in the new session");
assert.equal(readFileSync(planPath, "utf8"), approvedBody, "retry does not rewrite the approved plan");
assert.ok(implBranch.entries.some((e) => e.type === "model_change" && e.modelId === "claude-sonnet-4-5"), "model_change recorded");
assert.equal(lastCall("setModel")[1], "anthropic/claude-sonnet-4-5", "model applied in the new session");
assert.equal(lastCall("setThinkingLevel")[1], "high", "thinking level applied");
assert.ok(implBranch.entries.some((e) => e.customType === "plan-flow-handoff-applied"), "handoff marked applied");
const implState = implBranch.entries.filter((e) => e.customType === "plan-flow").at(-1);
assert.equal(implState?.data.phase, "off", "implementation session does not inherit the planning phase");
assert.equal(activeBranch.entries.at(-1).data.phase, "ready", "origin session keeps the approved plan state");

// removed subcommands do not save or start sessions
const beforeRemoved = activeBranch.entries.length;
await runCommand("save", ctx);
await runCommand("handoff", ctx);
assert.equal(activeBranch.entries.length, beforeRemoved, "old subcommands have no effect");
await runCommand("stop", ctx);
const stoppedDialogs = calls.filter((c) => c[0] === "confirm").length;
await runCommand("approve", ctx);
assert.equal(calls.filter((c) => c[0] === "confirm").length, stoppedDialogs, "no session prompt without an approved plan");
await runCommand("start other", ctx);
await runCommand("stop", ctx);
assert.equal(activeBranch.entries.at(-1).data.phase, "off", "stop turns the flow off");

// 7. guard toggle, back, restart guard
activeBranch.entries.push({ type: "custom", customType: "plan-flow", data: { phase: "investigate", task: "t", guard: true, updatedAt: new Date().toISOString() } });
await runCommand("guard off", ctx);
assert.equal(activeBranch.entries.at(-1).data.guard, false);
assert.equal(await guardHandler({ type: "tool_call", toolCallId: "t4", toolName: "write", input: {} }, ctx), undefined, "guard off does not block");
await runCommand("back plan", ctx);
assert.equal(activeBranch.entries.at(-1).data.phase, "plan");

// 8. resume restores phase from branch entries
await runCommand("start review 6-max snapshot geometry", ctx);
const restored = makeCtx(activeBranch);
await fire("session_start", { type: "session_start" }, restored);
const before2 = { type: "before_agent_start", systemPrompt: "base", systemPromptOptions: { sections: {} } };
await fire("before_agent_start", before2, restored);
assert.match(before2.systemPromptOptions.sections.plan_flow, /6-max/, "state restored on resume");

// 9. declining a transition keeps the phase
await runCommand("summary", ctx);
const declinedCtx = makeCtx(activeBranch, { confirm: () => false });
const declined = await tools.plan_advance.execute("tc", { to: "investigate", reason: "need more" }, undefined, undefined, declinedCtx);
assert.match(declined.content[0].text, /declined/);

// 10. a model-requested transition to planning also creates the draft file
await runCommand("start tool-requested plan", ctx);
await runCommand("summary", ctx);
activeBranch.entries.push(assistantMessage("SUMMARY: tool-requested"));
const toolAdvance = await tools.plan_advance.execute(
	"tc",
	{ to: "plan", reason: "summary is complete", title: "tool requested plan" },
	undefined,
	undefined,
	ctx,
);
assert.match(toolAdvance.content[0].text, /Plan file:/, "tool response points to the plan file");
assert.match(toolAdvance.content[0].text, /Plan title: tool requested plan/, "plan_advance accepts a title");
const toolPlanState = activeBranch.entries.at(-1).data;
assert.equal(toolPlanState.phase, "plan");
assert.match(toolPlanState.planPath, /-tool-requested-plan\.md$/);
assert.ok(toolPlanState.planPath && existsSync(toolPlanState.planPath));
const toolDraft = readFileSync(toolPlanState.planPath, "utf8");
assert.match(toolDraft, /plan-flow: replace this comment/);
assert.doesNotMatch(toolDraft, /Status: DRAFT|## Approved summary/);
assert.ok(
	toolAdvance.content[0].text.includes(toolPlanState.planPath.replace(/\\/g, "/")),
	"tool response carries the exact path",
);

// re-approving a revised summary never writes the summary into the plan file
await runCommand("back summary", ctx);
activeBranch.entries.push(assistantMessage("SUMMARY: revised"));
await runCommand("approve", ctx);
const revisedState = activeBranch.entries.at(-1).data;
assert.equal(revisedState.phase, "plan");
assert.equal(revisedState.planPath, toolPlanState.planPath, "re-approval keeps the same file");
const revisedBody = readFileSync(revisedState.planPath, "utf8");
assert.equal(revisedBody, toolDraft, "the summary never reaches the plan file");
assert.doesNotMatch(revisedBody, /SUMMARY: revised|SUMMARY: tool-requested/);
await runCommand("stop", ctx);

// Non-interactive approval still approves the file and provides a manual handoff prompt.
await runCommand("start offline plan", ctx);
await runCommand("summary", ctx);
activeBranch.entries.push(assistantMessage("SUMMARY: offline"));
await runCommand("approve", ctx);
const offlinePath = activeBranch.entries.at(-1).data.planPath;
assert.ok(offlinePath && existsSync(offlinePath), "offline plan file created at summary approval");
const offlineBody = readFileSync(offlinePath, "utf8").replace(/<!-- plan-flow:[\s\S]*?-->/, "PLAN: offline\n1. do the thing\nValidation: run the tests");
writeFileSync(offlinePath, offlineBody, "utf8");
const noUiCtx = makeCtx(activeBranch);
noUiCtx.hasUI = false;
clearCalls();
await runCommand("approve", noUiCtx);
assert.equal(activeBranch.entries.at(-1).data.phase, "ready");
assert.equal(activeBranch.entries.at(-1).data.planPath, offlinePath);
assert.equal(readFileSync(offlinePath, "utf8"), offlineBody, "offline approval never rewrites the plan");
assert.match(lastCall("notify")[1], /Open a new session manually and use: Plan file: `.pi\/plans\//);
assert.equal(calls.filter((c) => c[0] === "confirm").length, 0);

console.log("OK - plan-flow smoke test passed");
console.log(`temp project: ${cwd}`);
