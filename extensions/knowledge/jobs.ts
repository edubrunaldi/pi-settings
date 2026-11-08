/**
 * knowledge — ingestion job state machine.
 *
 * Pure: no filesystem, no clocks of its own (`now` is always passed in), no mutation. Every
 * transition returns a new job, so a test can walk a whole pipeline and a crash mid-run leaves
 * the persisted job in a state that says exactly what finished.
 *
 * Why this exists: ingestion is long (download, transcribe, extract frames) and the model, not
 * this code, does the distillation. So a job has two distinct phases and one explicit handoff:
 *
 *   mechanical stages  ->  evidence_ready  ->  (model reads evidence, writes records)  ->  distilled
 *
 * Invariants:
 * - a stage runs at most once per attempt; a `done` stage with its artifacts present is skipped
 *   on resume, which is what makes an interrupted run cheap to continue;
 * - terminal states (`distilled`, `failed`, `cancelled`) refuse further transitions instead of
 *   quietly accepting them — a resumed job must be a new job or an explicit retry;
 * - `evidence_ready` is not success. It means "extraction finished"; whether the extraction was
 *   complete lives in `stages[*].status` and in the coverage report.
 */

import type { CoverageEntry, IngestJob, SourceKind, SourceState } from "./types.ts";

/** Mechanical stages per source kind, in execution order. `evidence` is always last. */
export const STAGES: Record<SourceKind, readonly string[]> = {
	youtube: ["meta", "captions", "audio", "transcribe", "frames", "evidence"],
	web: ["fetch", "extract", "evidence"],
	file: ["probe", "extract", "transcribe", "frames", "evidence"],
};

export const TERMINAL_STATES: readonly SourceState[] = ["distilled", "failed", "cancelled"];

export function stagesFor(kind: SourceKind): readonly string[] {
	return STAGES[kind] ?? STAGES.web;
}

export function isTerminal(state: SourceState): boolean {
	return TERMINAL_STATES.includes(state);
}

function emptyStages(kind: SourceKind): Record<string, CoverageEntry> {
	const stages: Record<string, CoverageEntry> = {};
	for (const stage of stagesFor(kind)) stages[stage] = { stage, status: "skipped", detail: "not started" };
	return stages;
}

export function createJob(input: {
	id: string;
	sourceId: string;
	kind: SourceKind;
	target: string;
	fingerprint: string;
	now: number;
}): IngestJob {
	return {
		schema: 1,
		id: input.id,
		sourceId: input.sourceId,
		kind: input.kind,
		target: input.target,
		state: "queued",
		stage: stagesFor(input.kind)[0] ?? "evidence",
		stages: emptyStages(input.kind),
		createdAt: input.now,
		updatedAt: input.now,
		fingerprint: input.fingerprint,
		records: [],
	};
}

/** Refuse a transition that would corrupt the job instead of applying it silently. */
function assertMutable(job: IngestJob, action: string): void {
	if (isTerminal(job.state)) {
		throw new Error(`job ${job.id} is ${job.state}: ${action} refused — start a new job to reprocess this source`);
	}
}

function assertKnownStage(job: IngestJob, stage: string): void {
	if (!stagesFor(job.kind).includes(stage)) {
		throw new Error(`stage "${stage}" is not part of a ${job.kind} job (expected one of: ${stagesFor(job.kind).join(", ")})`);
	}
}

export function beginStage(job: IngestJob, stage: string, now: number): IngestJob {
	assertMutable(job, "beginStage");
	assertKnownStage(job, stage);
	return {
		...job,
		state: "running",
		stage,
		updatedAt: now,
		stages: { ...job.stages, [stage]: { stage, status: "skipped", detail: "running" } },
	};
}

export function finishStage(
	job: IngestJob,
	stage: string,
	status: CoverageEntry["status"],
	detail: string | undefined,
	ms: number | undefined,
	now: number,
): IngestJob {
	assertMutable(job, "finishStage");
	assertKnownStage(job, stage);
	return {
		...job,
		state: "running",
		stage,
		updatedAt: now,
		stages: { ...job.stages, [stage]: { stage, status, ...(detail ? { detail } : {}), ...(ms !== undefined ? { ms } : {}) } },
	};
}

export function markEvidenceReady(job: IngestJob, now: number): IngestJob {
	assertMutable(job, "markEvidenceReady");
	return { ...job, state: "evidence_ready", stage: "evidence", updatedAt: now };
}

/** Records written from this job. Idempotent: re-adding an id does not duplicate it. */
export function markDistilled(job: IngestJob, recordIds: string[], now: number): IngestJob {
	if (job.state === "distilled" || job.state === "evidence_ready" || job.state === "running" || job.state === "queued") {
		const records = Array.from(new Set([...job.records, ...recordIds.filter(Boolean)]));
		return { ...job, state: "distilled", records, updatedAt: now };
	}
	throw new Error(`job ${job.id} is ${job.state}: cannot attach records`);
}

export function failJob(job: IngestJob, error: string, now: number): IngestJob {
	// Terminal states are sticky: a cancelled or already-failed job keeps its own history instead of
	// being relabelled by whatever bubbled up afterwards.
	if (isTerminal(job.state)) return job;
	return {
		...job,
		state: "failed",
		error,
		updatedAt: now,
		stages: {
			...job.stages,
			...(job.stages[job.stage] && job.stages[job.stage].status === "skipped" && job.stages[job.stage].detail === "running"
				? { [job.stage]: { stage: job.stage, status: "failed" as const, detail: error } }
				: {}),
		},
	};
}

export function cancelJob(job: IngestJob, now: number): IngestJob {
	if (isTerminal(job.state)) return job;
	return { ...job, state: "cancelled", updatedAt: now };
}

