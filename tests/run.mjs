// Behavior tests for extensions/ask/ — no model calls, no network.
// The host packages (typebox, @earendil-works/*) are stubbed in tests/stubs and copied into
// <repo>/node_modules on first run, so a fresh clone only needs `node tests/run.mjs`.
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Stubs live at tests/stubs and are seeded into <repo>/node_modules, where both tests/ and
// extensions/ can resolve them (Node only walks up from the importing file). Each host package is
// checked on its own and re-copied when its content differs, so node_modules left by an earlier run
// still receives a new package or an edited stub.
const stubDir = fileURLToPath(new URL("./stubs", import.meta.url));
const stubTarget = fileURLToPath(new URL("../node_modules", import.meta.url));
const stubPackages = ["typebox", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

function stubIsStale(pkg) {
	const target = join(stubTarget, pkg, "index.js");
	if (!existsSync(target)) return true;
	try {
		return readFileSync(join(stubDir, pkg, "index.js"), "utf8") !== readFileSync(target, "utf8");
	} catch {
		return true;
	}
}

for (const pkg of stubPackages) {
	if (stubIsStale(pkg)) cpSync(join(stubDir, pkg), join(stubTarget, pkg), { recursive: true });
}

const calls = [];
const tools = {};

/** The only host API this extension touches: one tool registration. */
const pi = {
	registerTool(tool) {
		tools[tool.name] = tool;
	},
};

/**
 * Tool context. The picker needs a terminal, so `ui.custom` is stubbed: a test that does not provide
 * `dialogs.custom` gets a loud failure instead of a promise that never settles, which is exactly the
 * degrade path (`ui_unavailable`) the extension must handle.
 */
function makeCtx(overrides = {}, dialogs = {}) {
	return {
		mode: "tui",
		hasUI: true,
		signal: undefined,
		ui: {
			custom: async (factory) => {
				calls.push(["custom"]);
				if (!dialogs.custom) throw new Error("no custom UI in this test: pass dialogs.custom");
				return dialogs.custom(factory);
			},
			theme: { fg: (_color, text) => text },
		},
		...overrides,
	};
}

function clearCalls() {
	calls.length = 0;
}

// ---------------------------------------------------------------- ask (extensions/ask/)

const {
	CUSTOM_LABEL,
	buildAnswers,
	formatAnswerText,
	normalizeQuestions,
	optionsFor,
	sanitizeText,
	selectSingle,
	togglePick,
} = await import("../extensions/ask/logic.ts");

const scopeQuestion = {
	id: "scope",
	header: "Scope",
	prompt: "How much of the pipeline should change?",
	options: [
		{ label: "Minimal", description: "Retry only." },
		{ label: "Complete", description: "Retry plus quarantine." },
	],
};
const testsQuestion = { ...scopeQuestion, id: "tests", header: "Tests", type: "multi" };
const askInput = (questions) => ({ questions });

// 1. limits are enforced, and every error names the limit it broke
assert.equal(normalizeQuestions(askInput([])).ok, false, "zero questions are refused");
assert.match(normalizeQuestions(askInput([])).error, /1 to 4 entries/);
assert.match(normalizeQuestions({}).error, /questions must be an array/, "a missing questions array is refused");
const fiveQuestions = Array.from({ length: 5 }, (_value, index) => ({ ...scopeQuestion, id: `q${index}` }));
assert.match(normalizeQuestions(askInput(fiveQuestions)).error, /1 to 4 entries/, "five questions are refused");
assert.match(
	normalizeQuestions(askInput([{ ...scopeQuestion, options: [{ label: "Only" }] }])).error,
	/2 to 8 entries/,
	"one option is refused",
);
const nineOptions = Array.from({ length: 9 }, (_value, index) => ({ label: `option ${index}` }));
assert.match(normalizeQuestions(askInput([{ ...scopeQuestion, options: nineOptions }])).error, /2 to 8 entries/);
const duplicateIds = normalizeQuestions(askInput([scopeQuestion, { ...scopeQuestion, header: "Other" }]));
assert.equal(duplicateIds.ok, false, "ids must be unique");
assert.match(duplicateIds.error, /unique/);
const blankLabel = normalizeQuestions(askInput([{ ...scopeQuestion, options: [{ label: "   " }, { label: "b" }] }]));
assert.equal(blankLabel.ok, false, "an empty label is refused");
assert.match(blankLabel.error, /non-empty label/);
const accepted = normalizeQuestions(askInput([scopeQuestion]));
assert.equal(accepted.ok, true, "a minimal question is valid");
assert.equal(accepted.questions[0].type, "single", "type defaults to single");
const scope = accepted.questions[0];
const multi = normalizeQuestions(askInput([testsQuestion])).questions[0];

// 2. the free-form answer is always the last option, in both radio and checkbox questions
assert.equal(optionsFor(scope).at(-1).label, CUSTOM_LABEL, "custom is the last row");
assert.equal(optionsFor(multi).at(-1).custom, true, "and is flagged as the free-form row");
assert.equal(optionsFor(scope).length, scope.options.length + 1, "it is added on top of the declared options");

// 3. pick semantics
assert.deepEqual(togglePick([], 2), [2]);
assert.deepEqual(togglePick([2], 0), [0, 2], "picks stay sorted");
assert.deepEqual(togglePick([0, 2], 2), [0], "ticking twice removes the pick");
assert.deepEqual(selectSingle(3), [3]);
assert.deepEqual(selectSingle(-1), [], "a negative index clears the radio pick");

// 4. answers merge the written text the way each question type means it
const customIndex = scope.options.length;
const singleWithCustom = buildAnswers([scope], [[0]], ["just do it"])[0];
assert.deepEqual(singleWithCustom.picks, [customIndex], "a written answer replaces the radio pick");
assert.deepEqual(singleWithCustom.labels, ["just do it"]);
const multiWithCustom = buildAnswers([multi], [[0]], ["plus the flaky one"])[0];
assert.deepEqual(multiWithCustom.picks, [0, customIndex], "a written answer is appended in multi");
assert.deepEqual(multiWithCustom.labels, ["Minimal", "plus the flaky one"]);
const blankCustom = buildAnswers([multi], [[0, customIndex]], ["   "])[0];
assert.deepEqual(blankCustom.picks, [0], "an empty custom answer is dropped");
assert.equal(blankCustom.custom, undefined);
assert.deepEqual(blankCustom.labels, ["Minimal"], "the labels match the picked indices");

// 5. the model-facing text keeps the question kind and the written answer
const answered = {
	cancelled: false,
	questions: [scope, multi],
	answers: buildAnswers([scope, multi], [[1], [0]], [undefined, "plus the flaky one"]),
};
const answerText = formatAnswerText(answered);
assert.match(answerText, /Scope \(radio\): "Complete"/);
assert.match(answerText, /Tests \(checkbox\): "Minimal"; wrote: "plus the flaky one"/);
assert.match(formatAnswerText({ cancelled: true, reason: "cancelled", questions: [scope] }), /without answering/);

// 6. display text is stripped of ANSI and control characters
assert.equal(sanitizeText("\u001b[31mred\u001b[0m"), "red");
assert.equal(sanitizeText("a\u0000b"), "ab");
assert.equal(sanitizeText("two\nlines"), "two lines", "line breaks fold into spaces");

// 7. the tool contract: discoverable, guided, and one dialog at a time
const { default: askFactory } = await import("../extensions/ask/index.ts");
askFactory(pi);
const askTool = tools.ask;
assert.ok(askTool, "ask is registered");
assert.ok(askTool.promptSnippet, "a promptSnippet keeps ask in the system prompt tool list");
assert.ok((askTool.promptGuidelines ?? []).length >= 2, "the tool ships prompt guidelines");
assert.equal(askTool.executionMode, "sequential", "no dialog can race with another");
assert.equal(askTool.defaultActive, undefined, "ask stays active by design, in every session");

// 8. without a terminal UI the model is told to ask in prose, and no picker is opened
const headlessCtx = makeCtx({ mode: "print", hasUI: false });
clearCalls();
const unavailable = await askTool.execute("tc", askInput([scopeQuestion]), undefined, undefined, headlessCtx);
assert.equal(unavailable.details.cancelled, true);
assert.equal(unavailable.details.reason, "ui_unavailable");
assert.match(unavailable.content[0].text, /in prose/, "the result tells the model to ask in the reply");
assert.match(unavailable.content[0].text, /Scope|scope/, "the questions come back so nothing is invented");
assert.equal(calls.filter((c) => c[0] === "custom").length, 0, "no picker is opened without a terminal");

// a UI that fails also degrades instead of failing the turn
clearCalls();
const brokenUi = await askTool.execute("tc", askInput([scopeQuestion]), undefined, undefined, makeCtx());
assert.equal(brokenUi.details.reason, "ui_unavailable", "a failing picker degrades to prose");
assert.equal(calls.filter((c) => c[0] === "custom").length, 1, "the picker was attempted once");

// 9. invalid params throw with the violated limit in the message
await assert.rejects(
	() => askTool.execute("tc", askInput([{ ...scopeQuestion, options: [{ label: "Only" }] }]), undefined, undefined, headlessCtx),
	/ask: .*2 to 8 entries/,
	"the thrown message names the violated limit",
);

// the tool rows rebuild from params and from details (the resume path renders without a picker)
const renderTheme = { fg: (_color, text) => text, bold: (text) => text };
const callRow = askTool.renderCall(askInput([scopeQuestion, testsQuestion]), renderTheme).render(80).join("\n");
assert.match(callRow, /ask 2 questions \(Scope, Tests\)/);
const answerRows = askTool
	.renderResult({ content: [{ type: "text", text: answerText }], details: answered }, { expanded: false, isPartial: false }, renderTheme)
	.render(80);
assert.equal(answerRows.length, 2, "one row per answer");
assert.match(answerRows[0], /✓ Scope: "Complete"/);
assert.match(answerRows[1], /✓ Tests: "Minimal"; wrote "plus the flaky one"/);
assert.match(
	askTool.renderResult({ content: [], details: { cancelled: true, reason: "cancelled", questions: [scope] } }, {}, renderTheme).render(80).join("\n"),
	/Closed by the user/,
);
assert.match(
	askTool.renderResult({ content: [], details: unavailable.details }, {}, renderTheme).render(80).join("\n"),
	/No interactive UI/,
);

console.log("OK - ask smoke tests passed");
