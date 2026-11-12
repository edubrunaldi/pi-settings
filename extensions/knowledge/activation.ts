/**
 * User-wide activation, independent of the library root and session history.
 * Missing/invalid/unreadable state fails closed. Writes replace one atomic file;
 * concurrent commands use last successful rename wins. Watchers start only with
 * a session, tolerate replacement/missing files, and must be disposed on shutdown.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ActivationState {
	enabled: boolean;
	error?: string;
}

export function activationPath(agentDir: string): string {
	return join(agentDir, "knowledge", "activation.json");
}

export function readActivation(path: string): ActivationState {
	try {
		const state = JSON.parse(readFileSync(path, "utf8"));
		if (state?.version !== 1 || typeof state.enabled !== "boolean") {
			throw new Error("expected version 1 and a boolean enabled field");
		}
		return { enabled: state.enabled };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false };
		return { enabled: false, error: `Cannot read ${path}: ${(error as Error).message}` };
	}
}

export function writeActivation(path: string, enabled: boolean): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify({ version: 1, enabled }) + "\n", { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function watchActivation(path: string, changed: () => void): () => void {
	// Stat polling also observes atomic rename and a file that does not exist yet.
	watchFile(path, { interval: 250, persistent: false }, changed);
	return () => unwatchFile(path, changed);
}
