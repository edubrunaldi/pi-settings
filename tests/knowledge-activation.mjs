// Offline user-wide activation tests: real atomic files and watchers, no model/network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activationPath, readActivation, writeActivation } from "../extensions/knowledge/activation.ts";

export async function testKnowledgeActivation(factory) {
	const root = mkdtempSync(join(tmpdir(), "pi-knowledge-activation-"));
	const oldAgent = process.env.PI_AGENT_DIR_OVERRIDE;
	const oldLibrary = process.env.PI_KNOWLEDGE_DIR;
	process.env.PI_AGENT_DIR_OVERRIDE = root;
	process.env.PI_KNOWLEDGE_DIR = join(root, "library");
	const statePath = activationPath(root);
	const instances = [];
	function session() {
		const handlers = {}, commands = {}, tools = {}, notices = [], sent = [];
		let registrationChanged;
		const ctx = { hasUI: true, mode: "tui", ui: { notify: (...args) => notices.push(args) } };
		factory({
			registerTool: (tool) => { tools[tool.name] = tool; registrationChanged?.(tool); },
			registerCommand: (name, command) => { commands[name] = command; },
			on: (event, handler) => { (handlers[event] ??= []).push(handler); },
			sendUserMessage: (...args) => sent.push(args),
		});
		const instance = {
			tools, notices, sent,
			command: (args) => commands.knowledge.handler(args, ctx),
			emit: async (name, event = {}) => {
				let result;
				for (const handler of handlers[name] ?? []) result = await handler(event, ctx) ?? result;
				return result;
			},
			waitForExposure: (exposure) => {
				if (tools.knowledge.exposure === exposure) return Promise.resolve();
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => { registrationChanged = undefined; reject(new Error(`watcher did not publish ${exposure}`)); }, 4000);
					registrationChanged = (tool) => {
						if (tool.exposure !== exposure) return;
						clearTimeout(timer);
						registrationChanged = undefined;
						resolve();
					};
				});
			},
		};
		instances.push(instance);
		return instance;
	}
	try {
		assert.deepEqual(readActivation(statePath), { enabled: false });
		const a = session();
		assert.equal(a.tools.knowledge.exposure, "hidden", "off at registration, before startup");
		assert.equal(existsSync(statePath), false, "loading does not create state");
		assert.equal(existsSync(process.env.PI_KNOWLEDGE_DIR), false, "off does not initialize the library");
		assert.match(readFileSync(new URL("../skills/knowledge/SKILL.md", import.meta.url), "utf8"), /disable-model-invocation: true/);
		await a.command("");
		assert.match(a.notices.at(-1)[0], /off globally/);
		await a.command("learn https://example.org");
		assert.equal(a.sent.length, 0, "off never launches an agent to learn");
		assert.equal((await a.emit("input", { text: "/skill:knowledge learn" })).action, "handled");
		assert.equal(await a.emit("input", { text: "/skill:other" }), undefined);
		const offOptions = { skills: [{ name: "knowledge", disableModelInvocation: false }, { name: "other" }] };
		await a.emit("before_agent_start", { systemPromptOptions: offOptions });
		assert.equal(offOptions.skills[0].disableModelInvocation, true);
		assert.deepEqual(offOptions.skills[1], { name: "other" });
		const oldDefinition = a.tools.knowledge;
		assert.equal((await oldDefinition.execute("tc", { action: "search" })).isError, true, "stale handles fail closed");

		await a.emit("session_start");
		const b = session();
		await b.emit("session_start");
		const bOn = b.waitForExposure("direct");
		await a.command("on");
		await bOn;
		assert.equal(a.tools.knowledge.exposure, "direct");
		assert.deepEqual(readActivation(statePath), { enabled: true });
		assert.equal(session().tools.knowledge.exposure, "direct", "new runtime restores the global choice");
		const onOptions = { skills: [{ name: "knowledge", disableModelInvocation: true }] };
		await b.emit("before_agent_start", { systemPromptOptions: onOptions });
		assert.equal(onOptions.skills[0].disableModelInvocation, false);
		assert.equal(await b.emit("input", { text: "/skill:knowledge" }), undefined);
		const allowed = await b.tools.knowledge.execute("tc", { action: "teleport" });
		assert.match(allowed.content[0].text, /unknown action/, "on reaches the normal dispatcher");
		await a.command("off extra");
		assert.equal(readActivation(statePath).enabled, true, "invalid arguments do not change state");
		const bOff = b.waitForExposure("hidden");
		await a.command("off");
		await bOff;
		assert.equal(session().tools.knowledge.exposure, "hidden", "new sessions preserve off");

		// A distinct process writes the same user-wide state; no in-memory bus is involved.
		const externalOn = b.waitForExposure("direct");
		const child = spawnSync(process.execPath, ["--input-type=module", "-e",
			`import { writeActivation } from ${JSON.stringify(new URL("../extensions/knowledge/activation.ts", import.meta.url).href)}; writeActivation(${JSON.stringify(statePath)}, true);`,
		], { encoding: "utf8" });
		assert.equal(child.status, 0, child.stderr);
		await externalOn;

		// Boundary checks reconcile even before a watcher has observed the write.
		writeActivation(statePath, false);
		await b.emit("turn_start");
		assert.equal(b.tools.knowledge.exposure, "hidden");
		writeActivation(statePath, true);
		await b.emit("turn_start");
		assert.equal(b.tools.knowledge.exposure, "direct");
		writeFileSync(statePath, "broken json");
		await b.emit("turn_start");
		assert.equal(b.tools.knowledge.exposure, "hidden");
		await b.command("status");
		assert.match(b.notices.at(-1)[0], /Cannot read/);
		writeFileSync(statePath, JSON.stringify({ version: 1, enabled: "yes" }));
		assert.equal(readActivation(statePath).enabled, false);
		writeFileSync(statePath, JSON.stringify({ version: 2, enabled: true }));
		assert.equal(readActivation(statePath).enabled, false);
		rmSync(statePath);
		mkdirSync(statePath);
		await b.command("on");
		assert.equal(b.notices.at(-1)[1], "error", "save failure is not reported as success");
		assert.equal(b.tools.knowledge.exposure, "hidden");
		rmSync(statePath, { recursive: true });

		// Shutdown disposes watchers; explicit boundaries still read the latest state.
		for (const instance of instances) await instance.emit("session_shutdown");
		writeActivation(statePath, true);
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.equal(b.tools.knowledge.exposure, "hidden", "shutdown leaves no observer behind");
		await b.emit("turn_start");
		assert.equal(b.tools.knowledge.exposure, "direct");
		assert.equal(activationPath(root), statePath, "library root never determines activation scope");
	} finally {
		for (const instance of instances) await instance.emit("session_shutdown");
		if (oldAgent === undefined) delete process.env.PI_AGENT_DIR_OVERRIDE;
		else process.env.PI_AGENT_DIR_OVERRIDE = oldAgent;
		if (oldLibrary === undefined) delete process.env.PI_KNOWLEDGE_DIR;
		else process.env.PI_KNOWLEDGE_DIR = oldLibrary;
		rmSync(root, { recursive: true, force: true });
	}
	console.log("OK - knowledge global activation tests passed");
}
