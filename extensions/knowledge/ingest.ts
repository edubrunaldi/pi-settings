/**
 * knowledge — ingestion pipeline: sources -> evidence.
 *
 * This is the mechanical half. It fetches, transcribes, extracts frames and assembles an
 * `EvidenceBundle`; it never decides what a source *means*. Distillation belongs to the model,
 * which reads the bundle through `action=evidence` and writes records with `action=write`.
 *
 * Shape of a run:
 *
 *   classify -> deterministic job id -> stages in order -> bundle -> prune heavy media
 *
 * Invariants:
 * - the job file is persisted after every stage, so an interrupted run resumes instead of
 *   re-downloading. A finished stage whose artifacts are still on disk is skipped;
 * - the job id is derived from target + limits, so the same request twice is the same job, not two;
 * - `evidence_ready` is not success. Every stage records done/partial/skipped/failed with a reason,
 *   and that coverage report is part of what the model sees. A video with no captions and no ASR
 *   model produces a bundle that says so loudly instead of an empty record that looks complete;
 * - the abort signal reaches every subprocess and every fetch. Cancelling stops work; it does not
 *   delete what already finished, because that work is expensive to redo;
 * - external binaries are optional. A missing yt-dlp, ffmpeg, python or model file produces an
 *   actionable message naming the fix, never a stack trace and never a silent empty bundle;
 * - ffmpeg and yt-dlp run with `cwd` set and relative file names, because an absolute Windows path
 *   inside a filtergraph needs an escaped drive colon and fails in misleading ways.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	buildAsrArgs,
	buildAudioArgs,
	buildMetaArgs,
	buildModelDownloadArgs,
	buildSceneFrameArgs,
	buildSubtitleArgs,
	buildUniformFrameArgs,
	buildVideoArgs,
	dedupeSegments,
	KNOWN_WHISPER_MODELS,
	mergeSegments,
	parseFfmpegDuration,
	parseJson3,
	parseShowinfoTimestamps,
	parseVtt,
	parseWhisperJsonl,
	planSubtitles,
	sampleIntervalSeconds,
	toFilterPath,
	uniformFrameTimestamp,
	whisperFilterString,
	whisperModelUrl,
	ytDlpInvocation,
	ytDlpShimInvocation,
	type Exec,
	type VideoMeta,
} from "./media.ts";
import { classifyTarget, fingerprintFor, sourceIdFor } from "./logic.ts";
import { extractDocument, fetchDocument, fetchImages } from "./web.ts";
import { beginStage, cancelJob, createJob, failJob, finishStage, markEvidenceReady } from "./jobs.ts";
import type { KnowledgeStore } from "./store.ts";
import type { CoverageEntry, EvidenceBundle, FrameRef, IngestJob, SourceKind, TranscriptSegment } from "./types.ts";

export interface IngestDeps {
	exec: Exec;
	store: KnowledgeStore;
	now?: () => number;
	onProgress?: (job: IngestJob, message: string) => void;
}

export interface IngestOptions {
	target: string;
	focus?: string;
	domain?: string;
	topic?: string;
	/** Re-run even when a finished job for the same target and limits already exists. */
	force?: boolean;
	signal?: AbortSignal;
}

export interface IngestResult {
	job: IngestJob;
	bundle?: EvidenceBundle;
	/** Set when the run stopped early; the job still describes whatever did finish. */
	error?: string;
	reused: boolean;
}

/** Thrown when the caller's abort signal fires mid-stage. */
export class IngestCancelled extends Error {
	constructor() {
		super("cancelled");
		this.name = "IngestCancelled";
	}
}

const TEXT_EXTENSIONS =
	/\.(md|markdown|txt|text|html?|json|jsonl|csv|tsv|rst|adoc|srt|vtt|ya?ml|toml|ini|log|py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|sh|sql)$/i;
const AUDIO_EXTENSIONS = /\.(mp3|wav|m4a|aac|opus|ogg|oga|flac|wma|aiff?)$/i;
/**
 * Containers a downloaded audio track may arrive in. `yt-dlp -f bestaudio` usually produces
 * `.webm` (opus) or `.m4a`, and `.webm` is also a video container — so the lookup below is scoped
 * by the `audio.` file-name prefix, and this list only has to cover the possible suffixes.
 */
const DOWNLOADED_AUDIO_EXTENSIONS = /\.(mp3|wav|m4a|aac|opus|ogg|oga|flac|wma|aiff?|webm|mkv|mp4|mov|m4v)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|mkv|mov|webm|avi|m4v|mpg|mpeg|wmv|flv)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

const clock = (): number => Date.now();

function findFile(dir: string, prefix: string, extensions: RegExp): string | undefined {
	if (!existsSync(dir)) return undefined;
	const match = readdirSync(dir)
		.filter((file) => file.startsWith(prefix) && extensions.test(file))
		.sort((a, b) => statSync(join(dir, b)).size - statSync(join(dir, a)).size);
	return match.length ? join(dir, match[0]) : undefined;
}

function findFiles(dir: string, pattern: RegExp): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => pattern.test(file))
		.sort()
		.map((file) => join(dir, file));
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new IngestCancelled();
}

/**
 * Reuse a stage's cached artifact when an earlier run produced it. Resume must not pay twice for
 * the expensive stages — ASR above all — and a cached file is trusted only when it parses and is
 * non-empty, so a half-written file from a killed run falls through to a redo.
 */
function readCachedSegments(path: string): TranscriptSegment[] | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as TranscriptSegment[];
		return Array.isArray(parsed) && parsed.length ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Cached frames are reused only when every image is still on disk: citing a missing frame is worse than re-extracting it. */
function readCachedFrames(path: string, assets: string): FrameRef[] | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as FrameRef[];
		if (!Array.isArray(parsed) || !parsed.length) return undefined;
		return parsed.every((frame) => existsSync(join(assets, frame.file))) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Size note for a model this run had to fetch, so a slow first run explains itself. */
function modelNote(name: string, downloaded: boolean | undefined): string {
	if (!downloaded) return "";
	const known = KNOWN_WHISPER_MODELS[name];
	return known ? ` (model downloaded, ~${Math.round(known.bytes / 1_000_000)} MB)` : " (model downloaded)";
}

/** Last meaningful lines of a subprocess log, for an error a human can act on. */
function logTail(text: string, lines = 3, max = 320): string {
	return (text ?? "")
		.split(/\r?\n/)
		.filter((line) => line.trim() && !/^\[download\]|^\s*frame=|^\s*size=/.test(line))
		.slice(-lines)
		.join(" | ")
		.slice(0, max);
}

/** Run one stage: persist before and after, time it, and turn a throw into a failed stage. */
async function runStage(
	deps: IngestDeps,
	job: IngestJob,
	stage: string,
	work: (note: (message: string) => void) => Promise<{ status: CoverageEntry["status"]; detail?: string }>,
	signal: AbortSignal | undefined,
): Promise<{ job: IngestJob; ok: boolean; detail?: string }> {
	const now = deps.now ?? clock;
	const started = now();
	let current = beginStage(job, stage, started);
	deps.store.writeJob(current);
	deps.onProgress?.(current, `stage ${stage}: started`);
	// A long stage must say what it is doing, or a 148 MB model download looks like a hang.
	const note = (message: string): void => deps.onProgress?.(current, `stage ${stage}: ${message}`);
	try {
		assertNotAborted(signal);
		const outcome = await work(note);
		current = finishStage(current, stage, outcome.status, outcome.detail, now() - started, now());
		deps.store.writeJob(current);
		deps.onProgress?.(current, `stage ${stage}: ${outcome.status}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
		return { job: current, ok: outcome.status === "done" || outcome.status === "partial", detail: outcome.detail };
	} catch (error) {
		if (error instanceof IngestCancelled || signal?.aborted) {
			current = cancelJob(finishStage(current, stage, "failed", "cancelled", now() - started, now()), now());
			deps.store.writeJob(current);
			throw new IngestCancelled();
		}
		const message = (error as Error)?.message ?? String(error);
		current = finishStage(current, stage, "failed", message, now() - started, now());
		deps.store.writeJob(current);
		deps.onProgress?.(current, `stage ${stage}: failed — ${message}`);
		return { job: current, ok: false, detail: message };
	}
}

// ---------------------------------------------------------------- external tools

export interface ToolProbe {
	ytDlp?: { command: string; args: string[] };
	ffmpeg: boolean;
	error?: string;
}

/**
 * Locate the external binaries. `python -m yt_dlp` is tried before the console shim because a
 * user-level pip install leaves the shim off PATH.
 *
 * Probed on every run rather than cached for the process: two cheap subprocesses per ingestion are
 * nothing next to a video download, and a cache would keep reporting a binary that disappeared — or
 * keep missing one the user just installed.
 */
export async function probeTools(exec: Exec, signal?: AbortSignal): Promise<ToolProbe> {
	let ffmpeg = false;
	try {
		const result = await exec("ffmpeg", ["-hide_banner", "-version"], { timeout: 20_000, signal });
		ffmpeg = result.code === 0;
	} catch {
		ffmpeg = false;
	}

	for (const candidate of [ytDlpInvocation(), ytDlpShimInvocation()]) {
		try {
			const result = await exec(candidate.command, [...candidate.args, "--version"], { timeout: 60_000, signal });
			if (result.code === 0 && /\d{4}\.\d{2}\.\d{2}/.test(`${result.stdout}${result.stderr}`)) {
				return { ytDlp: { command: candidate.command, args: candidate.args }, ffmpeg };
			}
		} catch {
			/* try the next candidate */
		}
	}
	return {
		ffmpeg,
		error: ffmpeg
			? "yt-dlp was not found. Install it with: python -m pip install --user yt-dlp"
			: "neither yt-dlp nor ffmpeg was found. Install ffmpeg, then: python -m pip install --user yt-dlp",
	};
}

/**
 * Make sure the ASR model exists locally, downloading it once.
 *
 * `limits.whisperModel` is either a bare file name (fetched into `_models/`) or a path to a model
 * the user already has — whisper.cpp users usually do, and making them download it again would be
 * rude. A download is verified against the known size before it is promoted, so a truncated file is
 * never loaded as a model; the partial file is kept so the next attempt resumes it.
 */
export async function ensureWhisperModel(
	deps: IngestDeps,
	modelName: string,
	signal?: AbortSignal,
	note?: (message: string) => void,
): Promise<{ path?: string; downloaded?: boolean; error?: string }> {
	const usable = (candidate: string): boolean => existsSync(candidate) && statSync(candidate).size > 1_000_000;

	if (/[\\/]/.test(modelName)) {
		const explicit = resolve(modelName);
		return usable(explicit)
			? { path: explicit }
			: {
					error:
						`limits.whisperModel points at ${explicit}, which is not a model file of at least 1 MB. ` +
						"Set it to a ggml-*.bin name to download one, or to the path of a model you already have.",
				};
	}

	const path = deps.store.modelPath(modelName);
	if (usable(path)) return { path };
	mkdirSync(dirname(path), { recursive: true });

	const expected = KNOWN_WHISPER_MODELS[modelName]?.bytes;
	const partial = `${path}.part`;
	const already = existsSync(partial) ? statSync(partial).size : 0;
	note?.(
		`downloading ASR model ${modelName}${expected ? ` (~${Math.round(expected / 1_000_000)} MB)` : ""}${
			already ? `, resuming from ${Math.round(already / 1_000_000)} MB` : ""
		}`,
	);

	try {
		const result = await deps.exec("curl", buildModelDownloadArgs(whisperModelUrl(modelName), partial), {
			timeout: 16 * 60_000,
			signal,
		});
		if (!existsSync(partial)) {
			return {
				error: `could not download the ASR model ${modelName} (curl exit ${result.code}). Set limits.whisperModel to a model you already have, or use a source that has captions.`,
			};
		}
		const size = statSync(partial).size;
		// A short file, even with exit 0, is a stalled transfer and not a model: keep it for a resume.
		if (expected && size < expected * 0.9) {
			return {
				error:
					`the ASR model download stopped at ${Math.round(size / 1_000_000)} MB of ~${Math.round(expected / 1_000_000)} MB ` +
					`(curl exit ${result.code}). The partial file is kept: run learn again to resume it, or set limits.whisperModel to a model you already have.`,
			};
		}
		if (result.code !== 0) {
			return { error: `could not download the ASR model ${modelName} (curl exit ${result.code})` };
		}
		renameSync(partial, path);
		return { path, downloaded: true };
	} catch (error) {
		return { error: `could not download the ASR model ${modelName}: ${(error as Error).message}` };
	}
}

// ---------------------------------------------------------------- frames

/** ffmpeg accepts forward slashes everywhere on Windows; backslashes invite escaping surprises. */
function posixPath(path: string): string {
	return String(path).split(/[\\/]/).join("/");
}

/**
 * Uniform sampling is primary because its timestamps are arithmetic — frame N sits at
 * (N-1)*interval — and cannot drift when ffmpeg changes its log format. Scene detection
 * supplements it, and a threshold that matches nothing is a normal outcome, not an error: a real
 * talking-head video measured a maximum scene score of 0.059, so `gt(scene,0.3)` selects nothing.
 *
 * Frame paths are absolute on purpose: only filtergraph option values (the whisper model and its
 * destination) need the relative-path treatment, and mixing the two is how frames end up written
 * somewhere the pipeline does not look for them.
 */
export async function extractFrames(
	deps: IngestDeps,
	video: string,
	cwd: string,
	assets: string,
	durationSeconds: number | undefined,
	signal?: AbortSignal,
): Promise<FrameRef[]> {
	const limits = deps.store.config.limits;
	mkdirSync(assets, { recursive: true });
	const input = existsSync(join(cwd, basename(video))) ? basename(video) : posixPath(video);

	let duration = durationSeconds ?? 0;
	if (!duration || duration <= 0) {
		const probe = await deps.exec("ffmpeg", ["-hide_banner", "-i", input], { cwd, timeout: 120_000, signal });
		duration = parseFfmpegDuration(probe.stderr) ?? 0;
	}

	const interval = sampleIntervalSeconds(duration, limits.maxFrames, limits.sampleEverySeconds);
	const collected: FrameRef[] = [];

	const uniformDir = join(assets, "uni");
	mkdirSync(uniformDir, { recursive: true });
	await deps.exec(
		"ffmpeg",
		buildUniformFrameArgs(input, interval, limits.frameWidth, posixPath(join(uniformDir, "u_%05d.jpg"))),
		{
			cwd,
			timeout: limits.commandTimeoutSeconds * 1000,
			signal,
		},
	);
	// Exit codes are not trustworthy here; the files on disk are.
	for (const file of findFiles(uniformDir, /^u_\d{5}\.jpg$/i)) {
		const number = Number(/u_(\d{5})\.jpg/i.exec(basename(file))?.[1] ?? 0);
		const at = uniformFrameTimestamp(number, interval);
		if (duration && at > duration + interval) continue;
		collected.push({ file, at, reason: "sample", bytes: statSync(file).size });
		if (collected.length >= limits.maxFrames) break;
	}

	let sceneDir: string | undefined;
	if (collected.length < limits.maxFrames && duration > 0) {
		sceneDir = join(assets, "scn");
		mkdirSync(sceneDir, { recursive: true });
		const threshold = limits.sceneThreshold;
		const scene = await deps.exec(
			"ffmpeg",
			buildSceneFrameArgs(input, threshold, limits.frameWidth, posixPath(join(sceneDir, "s_%05d.jpg"))),
			{
				cwd,
				timeout: limits.commandTimeoutSeconds * 1000,
				signal,
			},
		);
		const times = parseShowinfoTimestamps(scene.stderr);
		findFiles(sceneDir, /^s_\d{5}\.jpg$/i).forEach((file, index) => {
			if (collected.length >= limits.maxFrames) return;
			const at = times[index] ?? 0;
			// Skip a cut that sits next to a frame already kept. The window is a quarter of the sampling
			// interval, not half: with half, every point of the timeline is within the window of some
			// sampled frame and scene detection could never contribute anything at all.
			if (collected.some((frame) => Math.abs(frame.at - at) < Math.max(2, interval / 4))) return;
			collected.push({ file, at, reason: "scene_change", bytes: statSync(file).size });
		});
	}

	// Stable, readable names in timeline order, so a citation (`frame_012.jpg @ 00:02:00`) is
	// checkable. A frame that cannot be moved into the assets directory is dropped rather than
	// listed under a name that does not exist on disk.
	collected.sort((a, b) => a.at - b.at);
	const frames: FrameRef[] = [];
	for (const frame of collected) {
		const target = `frame_${String(frames.length).padStart(3, "0")}.jpg`;
		const destination = join(assets, target);
		if (basename(frame.file) !== target) {
			try {
				renameSync(frame.file, destination);
			} catch {
				try {
					copyFileSync(frame.file, destination);
				} catch {
					continue;
				}
			}
		}
		frames.push({ ...frame, file: target, bytes: existsSync(destination) ? statSync(destination).size : frame.bytes });
	}

	// The scratch directories go only after every kept frame has been moved out of them.
	rmSync(uniformDir, { recursive: true, force: true });
	if (sceneDir) rmSync(sceneDir, { recursive: true, force: true });
	return frames;
}

// ---------------------------------------------------------------- youtube

interface SourceWork {
	meta?: VideoMeta;
	captionPlan?: { langs: string[]; origin: TranscriptSegment["origin"]; reason: string };
	segments: TranscriptSegment[];
	transcriptOrigin?: TranscriptSegment["origin"];
	audioFile?: string;
	videoFile?: string;
	frames: FrameRef[];
	durationSeconds?: number;
	parts: Partial<EvidenceBundle>;
}

function emptyWork(): SourceWork {
	return { segments: [], frames: [], parts: {} };
}

async function ingestYoutube(
	deps: IngestDeps,
	job: IngestJob,
	url: string,
	videoId: string,
	signal?: AbortSignal,
): Promise<{ job: IngestJob; work: SourceWork; error?: string }> {
	const store = deps.store;
	const limits = store.config.limits;
	const workdir = store.sourceDir(job.sourceId);
	const assets = store.assetsDir(job.sourceId);
	mkdirSync(assets, { recursive: true });
	const work = emptyWork();
	let current = job;

	const tools = await probeTools(deps.exec, signal);
	if (!tools.ytDlp) {
		current = failJob(current, tools.error ?? "yt-dlp was not found", (deps.now ?? clock)());
		store.writeJob(current);
		return { job: current, work, error: tools.error };
	}
	const yt = (args: string[], timeout: number): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> =>
		deps.exec(tools.ytDlp!.command, [...tools.ytDlp!.args, ...args], { cwd: workdir, timeout, signal });

	// meta --------------------------------------------------------------------
	{
		const outcome = await runStage(
			deps,
			current,
			"meta",
			async () => {
				const cachedMeta = join(workdir, "meta.json");
				if (existsSync(cachedMeta)) {
					try {
						work.meta = JSON.parse(readFileSync(cachedMeta, "utf8")) as VideoMeta;
						work.durationSeconds = Number(work.meta?.duration ?? 0) || undefined;
						return { status: "done", detail: `reusing cached metadata for ${work.meta?.id ?? videoId}` };
					} catch {
						rmSync(cachedMeta, { force: true });
					}
				}
				const result = await yt(buildMetaArgs(url), Math.min(300_000, limits.commandTimeoutSeconds * 1000));
				let meta: VideoMeta | undefined;
				try {
					meta = JSON.parse(result.stdout) as VideoMeta;
				} catch {
					meta = undefined;
				}
				if (!meta?.id) {
					throw new Error(`yt-dlp returned no metadata for ${videoId}: ${logTail(result.stderr)}`);
				}
				work.meta = meta;
				writeFileSync(cachedMeta, JSON.stringify(meta, null, 2), "utf8");
				const duration = Number(meta.duration ?? 0);
				if (duration > limits.maxDurationSeconds) {
					throw new Error(
						`video is ${Math.round(duration)}s, above the ${limits.maxDurationSeconds}s limit. Raise limits.maxDurationSeconds only if you really want it.`,
					);
				}
				work.durationSeconds = duration || undefined;
				return { status: "done", detail: `${meta.title ?? videoId} (${Math.round(duration)}s)` };
			},
			signal,
		);
		current = outcome.job;
		if (!outcome.ok) return { job: current, work, error: outcome.detail };
	}

	// captions ----------------------------------------------------------------
	{
		const outcome = await runStage(
			deps,
			current,
			"captions",
			async () => {
				const meta = work.meta ?? {};
				const wanted = Array.from(
					new Set(
						[meta.language, limits.whisperLanguage === "auto" ? undefined : limits.whisperLanguage, "en"].filter(
							(value): value is string => Boolean(value) && value !== "auto",
						),
					),
				);
				// Explicit language codes only: a regex like `en.*` also matches translated tracks and
				// triggers dozens of requests, which YouTube answers with HTTP 429.
				const plan = planSubtitles(meta, wanted);
				work.captionPlan = plan;
				if (!plan.langs.length) return { status: "skipped", detail: plan.reason };

				const cachedCaptions = readCachedSegments(join(workdir, "captions.json"));
				if (cachedCaptions) {
					work.segments = cachedCaptions;
					work.transcriptOrigin = cachedCaptions[0]!.origin;
					return { status: "done", detail: `reusing ${cachedCaptions.length} caption segments from a previous run` };
				}

				const result = await yt(buildSubtitleArgs(url, plan.langs, "sub"), limits.commandTimeoutSeconds * 1000);
				const files = findFiles(workdir, /^sub\..*\.(json3|vtt|srv3)$/i);
				if (!files.length) {
					const rate = /429|Too Many Requests/i.test(result.stderr) ? " (HTTP 429: too many caption requests)" : "";
					return { status: "skipped", detail: `${plan.reason}; no caption file produced${rate}` };
				}
				// Origin comes from the metadata, not from the file name: yt-dlp writes `sub.en.json3`
				// for a manual track and for an automatic one, so the name cannot tell them apart.
				const languageOf = (file: string): string => /^sub\.(.+)\.(json3|vtt|srv3)$/i.exec(basename(file))?.[1] ?? "";
				const manualLangs = new Set(Object.keys(meta.subtitles ?? {}));
				const autoLangs = new Set(Object.keys(meta.automatic_captions ?? {}));
				const rank = (file: string): number => {
					const language = languageOf(file);
					return (manualLangs.has(language) ? 0 : 2) + (/-orig$/i.test(language) ? 1 : 0);
				};
				const ranked = [...files].sort((a, b) => rank(a) - rank(b) || basename(a).localeCompare(basename(b)));
				const chosen = ranked[0]!;
				const chosenLanguage = languageOf(chosen);
				const origin: TranscriptSegment["origin"] = manualLangs.has(chosenLanguage)
					? "captions"
					: autoLangs.has(chosenLanguage)
						? "auto_captions"
						: plan.origin;
				const text = readFileSync(chosen, "utf8");
				const parsed = /\.vtt$/i.test(chosen) ? parseVtt(text, origin) : parseJson3(text, origin);
				if (!parsed.length) return { status: "partial", detail: `${basename(chosen)} parsed to zero segments` };
				work.segments = mergeSegments(dedupeSegments(parsed));
				work.transcriptOrigin = origin;
				writeFileSync(join(workdir, "captions.json"), JSON.stringify(work.segments, null, 2), "utf8");
				const covered = work.segments.at(-1)?.end ?? 0;
				const total = work.durationSeconds ?? 0;
				const partial = total > 0 && covered < total * 0.7;
				return {
					status: partial ? "partial" : "done",
					detail: `${work.segments.length} segments from ${basename(chosen)} (${origin}, language ${chosenLanguage || "unknown"})${
						partial ? ` covering only ${Math.round(covered)}s of ${Math.round(total)}s` : ""
					}`,
				};
			},
			signal,
		);
		current = outcome.job;
	}

	// audio -------------------------------------------------------------------
	{
		const outcome = await runStage(
			deps,
			current,
			"audio",
			async () => {
				const existing = findFile(workdir, "audio.", DOWNLOADED_AUDIO_EXTENSIONS);
				if (existing) {
					work.audioFile = existing;
					return { status: "done", detail: `reusing ${basename(existing)}` };
				}
				const result = await yt(buildAudioArgs(url), limits.commandTimeoutSeconds * 1000);
				const file = findFile(workdir, "audio.", DOWNLOADED_AUDIO_EXTENSIONS);
				if (!file) throw new Error(`no audio file produced (yt-dlp exit ${result.code}): ${logTail(result.stderr)}`);
				work.audioFile = file;
				return { status: "done", detail: `${basename(file)} (${Math.round(statSync(file).size / 1024)} KB)` };
			},
			signal,
		);
		current = outcome.job;
	}

	// transcribe --------------------------------------------------------------
	{
		const outcome = await runStage(
			deps,
			current,
			"transcribe",
			async (note) => {
				if (work.segments.length) {
					const covered = work.segments.at(-1)?.end ?? 0;
					const total = work.durationSeconds ?? 0;
					if (!total || covered >= total * 0.7) {
						return { status: "skipped", detail: `captions cover ${Math.round(covered)}s of ${Math.round(total)}s; local ASR not needed` };
					}
				}
				if (!tools.ffmpeg) return { status: "skipped", detail: "ffmpeg was not found, so local ASR is impossible" };
				const audio = work.audioFile ?? findFile(workdir, "audio.", DOWNLOADED_AUDIO_EXTENSIONS);
				if (!audio) return { status: "skipped", detail: "no audio file to transcribe" };
				work.audioFile = audio;

				const cachedAsr = readCachedSegments(join(workdir, "asr.json"));
				if (cachedAsr) {
					work.segments = cachedAsr;
					work.transcriptOrigin = "asr";
					return { status: "done", detail: `reusing ${cachedAsr.length} ASR segments from a previous run` };
				}

				const model = await ensureWhisperModel(deps, limits.whisperModel, signal, note);
				if (!model.path) throw new Error(model.error ?? "no ASR model available");

				const destination = "transcript.jsonl";
				const filter = whisperFilterString({
					model: toFilterPath(model.path, workdir),
					language: limits.whisperLanguage,
					translate: limits.whisperTranslate,
					destination,
				});
				note(`transcribing ${basename(audio)} with ${limits.whisperModel}`);
				const result = await deps.exec("ffmpeg", buildAsrArgs(basename(audio), filter), {
					cwd: workdir,
					timeout: limits.commandTimeoutSeconds * 1000,
					signal,
				});
				const outPath = join(workdir, destination);
				if (!existsSync(outPath)) throw new Error(`ASR produced no transcript (ffmpeg exit ${result.code}): ${logTail(result.stderr)}`);
				const parsed = parseWhisperJsonl(readFileSync(outPath, "utf8"));
				if (!parsed.length) throw new Error("ASR transcript was empty");
				const merged = mergeSegments(dedupeSegments(parsed));
				writeFileSync(join(workdir, "asr.json"), JSON.stringify(merged, null, 2), "utf8");
				const captionCover = work.segments.at(-1)?.end ?? 0;
				const asrCover = merged.at(-1)?.end ?? 0;
				// Partial captions plus full ASR: keep whichever covers more of the source.
				if (asrCover >= captionCover) {
					work.segments = merged;
					work.transcriptOrigin = "asr";
				}
				return {
					status: "done",
					detail: `${merged.length} ASR segments from ${limits.whisperModel}${modelNote(limits.whisperModel, model.downloaded)}; kept ${work.transcriptOrigin}`,
				};
			},
			signal,
		);
		current = outcome.job;
	}

	// frames ------------------------------------------------------------------
	{
		const outcome = await runStage(
			deps,
			current,
			"frames",
			async () => {
				if (!tools.ffmpeg) return { status: "skipped", detail: "ffmpeg was not found" };
				const cachedFrames = readCachedFrames(join(workdir, "frames.json"), assets);
				if (cachedFrames) {
					work.frames = cachedFrames;
					return { status: "done", detail: `reusing ${cachedFrames.length} frames from a previous run` };
				}
				let video = work.videoFile ?? findFile(workdir, "video.", VIDEO_EXTENSIONS);
				if (!video) {
					const result = await yt(buildVideoArgs(url, 360), limits.commandTimeoutSeconds * 1000);
					video = findFile(workdir, "video.", VIDEO_EXTENSIONS);
					if (!video) return { status: "failed", detail: `no video file for frame extraction (yt-dlp exit ${result.code}): ${logTail(result.stderr)}` };
				}
				work.videoFile = video;
				work.frames = await extractFrames(deps, video, workdir, assets, work.durationSeconds, signal);
				writeFileSync(join(workdir, "frames.json"), JSON.stringify(work.frames, null, 2), "utf8");
				if (!work.frames.length) return { status: "partial", detail: "no frames were extracted" };
				const scene = work.frames.filter((frame) => frame.reason === "scene_change").length;
				return { status: "done", detail: `${work.frames.length} frames (${scene} scene, ${work.frames.length - scene} sampled)` };
			},
			signal,
		);
		current = outcome.job;
	}

	return { job: current, work };
}

// ---------------------------------------------------------------- web

async function ingestWeb(
	deps: IngestDeps,
	job: IngestJob,
	url: string,
	sourceId: string,
	signal?: AbortSignal,
): Promise<{ job: IngestJob; work: SourceWork; error?: string }> {
	const store = deps.store;
	const limits = store.config.limits;
	const work = emptyWork();
	let current = job;
	const now = deps.now ?? clock;

	current = beginStage(current, "fetch", now());
	store.writeJob(current);
	const fetched = await fetchDocument(
		url,
		{ maxBytes: limits.maxHtmlBytes, timeoutMs: Math.min(120_000, limits.commandTimeoutSeconds * 1000) },
		signal,
	);
	if (!fetched.doc) {
		current = failJob(finishStage(current, "fetch", "failed", fetched.error, undefined, now()), fetched.error ?? "fetch failed", now());
		store.writeJob(current);
		return { job: current, work, error: fetched.error };
	}
	const doc = fetched.doc;
	current = finishStage(current, "fetch", "done", `HTTP ${doc.status}, ${doc.htmlBytes} bytes`, undefined, now());
	store.writeJob(current);

	const outcome = await runStage(
		deps,
		current,
		"extract",
		async () => {
			work.parts.title = doc.title;
			work.parts.author = doc.author;
			work.parts.publishedAt = doc.publishedAt;
			work.parts.language = doc.language;
			work.parts.sections = doc.sections;
			work.parts.codeBlocks = doc.codeBlocks;

			// Only figures that carry a caption or alt text are worth keeping: decoration is noise.
			const assets = store.assetsDir(sourceId);
			mkdirSync(assets, { recursive: true });
			const downloaded = await fetchImages(doc.images, doc.finalUrl, {
				maxImages: 8,
				maxBytes: 6 * 1024 * 1024,
				timeoutMs: 60_000,
				signal,
			});
			const images: NonNullable<EvidenceBundle["images"]> = [];
			for (const image of downloaded) {
				const data = (image as { data?: string }).data;
				if (!data) continue;
				writeFileSync(join(assets, image.file), Buffer.from(data, "base64"));
				images.push({
					file: image.file,
					...(image.caption ? { caption: image.caption } : {}),
					...(image.section ? { section: image.section } : {}),
				});
			}
			if (images.length) work.parts.images = images;

			const warnings = doc.warnings.filter((warning) => !/near-empty/.test(warning));
			return {
				status: warnings.length ? "partial" : "done",
				detail: `${doc.sections.length} sections, ${doc.codeBlocks.length} code blocks, ${images.length} figures${
					warnings.length ? ` — ${warnings.join("; ")}` : ""
				}`,
			};
		},
		signal,
	);
	current = outcome.job;
	return { job: current, work };
}

// ---------------------------------------------------------------- local files

async function ingestFile(
	deps: IngestDeps,
	job: IngestJob,
	path: string,
	signal?: AbortSignal,
): Promise<{ job: IngestJob; work: SourceWork; error?: string }> {
	const store = deps.store;
	const limits = store.config.limits;
	const workdir = store.sourceDir(job.sourceId);
	const assets = store.assetsDir(job.sourceId);
	mkdirSync(assets, { recursive: true });
	const work = emptyWork();
	let current = job;
	const absolute = resolve(path);
	const sourceDirOfMedia = dirname(absolute);

	if (!existsSync(absolute)) {
		const error = `file not found: ${absolute}`;
		current = failJob(current, error, (deps.now ?? clock)());
		store.writeJob(current);
		return { job: current, work, error };
	}

	// probe -------------------------------------------------------------------
	{
		const outcome = await runStage(
			deps,
			current,
			"probe",
			async () => {
				const size = statSync(absolute).size;
				work.parts.title = basename(absolute);
				if (IMAGE_EXTENSIONS.test(absolute)) {
					const target = join(assets, `frame_000.${basename(absolute).split(".").pop()}`);
					writeFileSync(target, readFileSync(absolute));
					work.frames = [{ file: basename(target), at: 0, reason: "sample", bytes: size }];
					return { status: "done", detail: `image, ${Math.round(size / 1024)} KB` };
				}
				if (TEXT_EXTENSIONS.test(absolute)) {
					if (size > limits.maxHtmlBytes) throw new Error(`file is ${size} bytes, above the ${limits.maxHtmlBytes} byte limit`);
					return { status: "done", detail: `text-like file, ${Math.round(size / 1024)} KB` };
				}
				const tools = await probeTools(deps.exec, signal);
				if (!tools.ffmpeg) throw new Error("ffmpeg was not found, so audio and video files cannot be processed");
				const probe = await deps.exec("ffmpeg", ["-hide_banner", "-i", posixPath(absolute)], {
					cwd: workdir,
					timeout: 120_000,
					signal,
				});
				const duration = parseFfmpegDuration(probe.stderr) ?? 0;
				work.durationSeconds = duration || undefined;
				if (duration > limits.maxDurationSeconds) {
					throw new Error(`media is ${Math.round(duration)}s, above the ${limits.maxDurationSeconds}s limit`);
				}
				return { status: "done", detail: `media, ${Math.round(duration)}s, ${Math.round(size / 1024 / 1024)} MB` };
			},
			signal,
		);
		current = outcome.job;
		if (!outcome.ok) return { job: current, work, error: outcome.detail };
	}

	// extract -----------------------------------------------------------------
	{
		const outcome = await runStage(
			deps,
			current,
			"extract",
			async () => {
				if (!TEXT_EXTENSIONS.test(absolute)) return { status: "skipped", detail: "media file: no document text to extract" };
				const text = readFileSync(absolute, "utf8");

				if (/\.html?$/i.test(absolute)) {
					const doc = extractDocument(text, `file://${absolute}`);
					work.parts.sections = doc.sections;
					work.parts.codeBlocks = doc.codeBlocks;
					if (doc.title) work.parts.title = doc.title;
					work.parts.language = doc.language;
					// Local figures are copied only when the file really exists next to the document.
					const images: NonNullable<EvidenceBundle["images"]> = [];
					doc.images.slice(0, 8).forEach((image, index) => {
						if (!image.caption && !image.alt) return;
						if (/^https?:/i.test(image.src)) return;
						const local = resolve(sourceDirOfMedia, image.src.replace(/^file:\/\//i, ""));
						if (!existsSync(local)) return;
						const file = `doc_${String(index).padStart(3, "0")}.${basename(local).split(".").pop()}`;
						writeFileSync(join(assets, file), readFileSync(local));
						images.push({ file, ...(image.caption ? { caption: image.caption } : {}), ...(image.section ? { section: image.section } : {}) });
					});
					if (images.length) work.parts.images = images;
					const warnings = doc.warnings.filter((warning) => !/near-empty/.test(warning));
					return {
						status: warnings.length ? "partial" : "done",
						detail: `${doc.sections.length} sections, ${images.length} figures${warnings.length ? ` — ${warnings.join("; ")}` : ""}`,
					};
				}

				if (/\.(srt|vtt)$/i.test(absolute)) {
					const parsed = parseVtt(text.includes("-->") ? text : toVttLike(text), "captions");
					if (!parsed.length) return { status: "partial", detail: "subtitle file parsed to zero segments" };
					work.segments = mergeSegments(parsed);
					work.transcriptOrigin = "captions";
					writeFileSync(join(workdir, "captions.json"), JSON.stringify(work.segments, null, 2), "utf8");
					return { status: "done", detail: `${work.segments.length} segments from a subtitle file` };
				}

				work.parts.sections = [{ heading: basename(absolute), level: 1, text, index: 0 }];
				return { status: "done", detail: `${text.split(/\r?\n/).length} lines of text` };
			},
			signal,
		);
		current = outcome.job;
	}

	// transcribe --------------------------------------------------------------
	{
		const outcome = await runStage(
			deps,
			current,
			"transcribe",
			async (note) => {
				if (work.segments.length) return { status: "skipped", detail: "a subtitle file already provided the transcript" };
				if (!AUDIO_EXTENSIONS.test(absolute) && !VIDEO_EXTENSIONS.test(absolute)) return { status: "skipped", detail: "not audio or video" };
				const tools = await probeTools(deps.exec, signal);
				if (!tools.ffmpeg) throw new Error("ffmpeg was not found");
				const cachedAsr = readCachedSegments(join(workdir, "asr.json"));
				if (cachedAsr) {
					work.segments = cachedAsr;
					work.transcriptOrigin = "asr";
					return { status: "done", detail: `reusing ${cachedAsr.length} ASR segments from a previous run` };
				}
				const model = await ensureWhisperModel(deps, limits.whisperModel, signal, note);
				if (!model.path) throw new Error(model.error ?? "no ASR model available");

				const destination = "transcript.jsonl";
				// cwd is our own source directory even for a file that lives elsewhere: the transcript must
				// not be written next to the user's media, and the model path stays relative.
				const filter = whisperFilterString({
					model: toFilterPath(model.path, workdir),
					language: limits.whisperLanguage,
					translate: limits.whisperTranslate,
					destination,
				});
				const result = await deps.exec("ffmpeg", buildAsrArgs(posixPath(absolute), filter), {
					cwd: workdir,
					timeout: limits.commandTimeoutSeconds * 1000,
					signal,
				});
				const outPath = join(workdir, destination);
				if (!existsSync(outPath)) throw new Error(`ASR produced no transcript (ffmpeg exit ${result.code}): ${logTail(result.stderr)}`);
				const parsed = parseWhisperJsonl(readFileSync(outPath, "utf8"));
				if (!parsed.length) throw new Error("ASR transcript was empty");
				work.segments = mergeSegments(dedupeSegments(parsed));
				writeFileSync(join(workdir, "asr.json"), JSON.stringify(work.segments, null, 2), "utf8");
				work.transcriptOrigin = "asr";
				return {
					status: "done",
					detail: `${work.segments.length} ASR segments from ${limits.whisperModel}${modelNote(limits.whisperModel, model.downloaded)}`,
				};
			},
			signal,
		);
		current = outcome.job;
	}

	// frames ------------------------------------------------------------------
	{
		const outcome = await runStage(
			deps,
			current,
			"frames",
			async () => {
				if (!VIDEO_EXTENSIONS.test(absolute)) return { status: "skipped", detail: "not a video file" };
				if (work.frames.length) return { status: "done", detail: `${work.frames.length} frames` };
				const cachedFrames = readCachedFrames(join(workdir, "frames.json"), assets);
				if (cachedFrames) {
					work.frames = cachedFrames;
					return { status: "done", detail: `reusing ${cachedFrames.length} frames from a previous run` };
				}
				const tools = await probeTools(deps.exec, signal);
				if (!tools.ffmpeg) return { status: "skipped", detail: "ffmpeg was not found" };
				work.frames = await extractFrames(deps, absolute, workdir, assets, work.durationSeconds, signal);
				writeFileSync(join(workdir, "frames.json"), JSON.stringify(work.frames, null, 2), "utf8");
				return work.frames.length
					? { status: "done", detail: `${work.frames.length} frames` }
					: { status: "partial", detail: "no frames were extracted" };
			},
			signal,
		);
		current = outcome.job;
	}

	return { job: current, work };
}

/** A subtitle file without `-->` timings still deserves a monotonic timeline. */
function toVttLike(text: string): string {
	const stamp = (seconds: number): string =>
		`00:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(Math.floor(seconds) % 60).padStart(2, "0")}.000`;
	return text
		.split(/\n\s*\n/)
		.filter((block) => block.trim())
		.map((block, index) => `${stamp(index * 3)} --> ${stamp(index * 3 + 3)}\n${block.replace(/\s+/g, " ").trim()}`)
		.join("\n\n");
}

// ---------------------------------------------------------------- assembly

function assembleBundle(input: {
	sourceId: string;
	kind: SourceKind;
	url?: string;
	path?: string;
	work: SourceWork;
	job: IngestJob;
	retrievedAt: number;
	focus?: string;
}): EvidenceBundle {
	const { work, job } = input;
	const segments = work.segments;
	const duration = work.durationSeconds ?? input.work.parts.durationSeconds;
	const covered = segments.at(-1)?.end ?? 0;
	const limitsHit: string[] = [];
	if (duration && covered && covered < duration * 0.9) limitsHit.push(`transcript covers ${Math.round(covered)}s of ${Math.round(duration)}s`);
	if (!segments.length && (input.kind === "youtube" || input.kind === "file")) {
		limitsHit.push("no transcript: nothing was captioned and no ASR ran");
	}

	return {
		schema: 1,
		sourceId: input.sourceId,
		kind: input.kind,
		state: job.state === "failed" ? "failed" : job.state === "cancelled" ? "cancelled" : "evidence_ready",
		...(input.url ? { url: input.url } : {}),
		...(input.path ? { path: input.path } : {}),
		...(work.parts.title || work.meta?.title ? { title: work.parts.title ?? work.meta?.title } : {}),
		...(work.parts.author || work.meta?.channel || work.meta?.uploader
			? { author: work.parts.author ?? work.meta?.channel ?? work.meta?.uploader }
			: {}),
		...(work.parts.publishedAt || work.meta?.upload_date
			? { publishedAt: work.parts.publishedAt ?? work.meta.upload_date }
			: {}),
		retrievedAt: input.retrievedAt,
		...(duration ? { durationSeconds: duration } : {}),
		...(work.parts.language || work.meta?.language ? { language: work.parts.language ?? work.meta?.language } : {}),
		...(input.focus ? { focus: input.focus } : {}),
		...(segments.length
			? {
					transcript: {
						origin: work.transcriptOrigin ?? "asr",
						...(work.captionPlan?.reason ? { note: work.captionPlan.reason } : {}),
						segmentCount: segments.length,
						segments,
						...(duration && covered < duration * 0.9 ? { partial: true } : {}),
					},
				}
			: {}),
		...(work.frames.length ? { frames: work.frames } : {}),
		...(work.parts.sections?.length ? { sections: work.parts.sections } : {}),
		...(work.parts.images?.length ? { images: work.parts.images } : {}),
		...(work.parts.codeBlocks?.length ? { codeBlocks: work.parts.codeBlocks } : {}),
		coverage: Object.values(job.stages).map((entry) => ({ ...entry })),
		...(limitsHit.length ? { limits: limitsHit } : {}),
		...(job.error ? { error: job.error } : {}),
	};
}

/** Write the bundle, apply media retention, and mark the job ready for distillation. */
function finalize(deps: IngestDeps, job: IngestJob, bundle: EvidenceBundle, signal?: AbortSignal): IngestJob {
	assertNotAborted(signal);
	const now = deps.now ?? clock;
	const store = deps.store;
	const limits = store.config.limits;

	const keep = new Set<string>();
	for (const frame of bundle.frames ?? []) keep.add(frame.file);
	for (const image of bundle.images ?? []) if (image.file) keep.add(image.file);

	const removed: string[] = [];
	if (limits.keepMedia !== "all") {
		if (limits.keepMedia === "audio") {
			for (const file of readdirSync(store.sourceDir(bundle.sourceId))) {
				if (/^audio\./i.test(file)) keep.add(file);
			}
		}
		removed.push(...store.pruneMedia(bundle.sourceId, Array.from(keep)));
	}

	// Downloaded containers are intermediates: frames and transcripts are the evidence we keep.
	const workdir = store.sourceDir(bundle.sourceId);
	if (existsSync(workdir)) {
		for (const file of readdirSync(workdir)) {
			const droppable = /^video\./i.test(file) || (/^audio\./i.test(file) && limits.keepMedia === "none");
			if (!droppable) continue;
			try {
				rmSync(join(workdir, file), { force: true });
				removed.push(file);
			} catch {
				/* retention is best effort; a locked file is not fatal */
			}
		}
	}

	const detail = removed.length ? `bundle written; removed ${removed.join(", ")}` : "bundle written";
	// The coverage report must include the stage that writes it, so a reader sees the whole run
	// instead of a report that stops one stage short of the truth.
	bundle.coverage = [
		...bundle.coverage.filter((entry) => entry.stage !== "evidence"),
		{ stage: "evidence", status: "done", detail },
	];
	store.writeBundle(bundle);

	const finished = finishStage(job, "evidence", "done", detail, undefined, now());
	const ready = markEvidenceReady(finished, now());
	store.writeJob(ready);
	return ready;
}

// ---------------------------------------------------------------- entry point

/**
 * Ingest one source, resuming whatever a previous run finished.
 *
 * Idempotent by construction: the job id comes from the target and the limits, so a second call
 * with the same inputs either returns the existing bundle or continues the interrupted run.
 */
export async function ingestSource(deps: IngestDeps, options: IngestOptions): Promise<IngestResult> {
	const now = deps.now ?? clock;
	const store = deps.store;
	const limits = store.config.limits;
	const classified = classifyTarget(options.target);

	if (classified.error) {
		const job = failJob(
			createJob({
				id: `job-invalid-${shortNow(now())}`,
				sourceId: "invalid",
				kind: classified.kind,
				target: options.target,
				fingerprint: "",
				now: now(),
			}),
			classified.error,
			now(),
		);
		return { job, error: classified.error, reused: false };
	}

	const sourceId = sourceIdFor(options.target);
	const fingerprint = fingerprintFor(options.target, limits);
	const jobId = `job-${fingerprint.slice(0, 12)}`;
	// A forced re-ingest starts clean. Reusing a cached meta.json, caption file or frame set would
	// make "force" indistinguishable from a resume, which is exactly what the caller asked to avoid.
	// Records that cite this source keep their text, but their evidence files are regenerated.
	if (options.force && existsSync(store.sourceDir(sourceId))) {
		rmSync(store.sourceDir(sourceId), { recursive: true, force: true });
	}
	mkdirSync(store.sourceDir(sourceId), { recursive: true });

	const existing = store.readJob(jobId);
	const existingBundle = store.readBundle(sourceId);
	if (!options.force && existing && existingBundle && (existing.state === "evidence_ready" || existing.state === "distilled")) {
		return { job: existing, bundle: existingBundle, reused: true };
	}

	const reusable = existing && !options.force && (existing.state === "queued" || existing.state === "running");
	let job = reusable
		? existing!
		: createJob({ id: jobId, sourceId, kind: classified.kind, target: classified.canonical, fingerprint, now: now() });
	store.writeJob(job);

	const started = now();
	try {
		if (classified.kind === "youtube") {
			const result = await ingestYoutube(deps, job, classified.canonical, classified.videoId ?? "", options.signal);
			job = result.job;
			if (result.error) return { job: failAndPersist(deps, job, result.error), error: result.error, reused: false };
			const bundle = assembleBundle({
				sourceId,
				kind: "youtube",
				url: classified.canonical,
				work: result.work,
				job,
				retrievedAt: started,
				...(options.focus ? { focus: options.focus } : {}),
			});
			job = finalize(deps, job, bundle, options.signal);
			return { job, bundle: store.readBundle(sourceId), reused: false };
		}

		if (classified.kind === "file") {
			const result = await ingestFile(deps, job, classified.canonical, options.signal);
			job = result.job;
			if (result.error) return { job: failAndPersist(deps, job, result.error), error: result.error, reused: false };
			const bundle = assembleBundle({
				sourceId,
				kind: "file",
				path: resolve(classified.canonical),
				work: result.work,
				job,
				retrievedAt: started,
				...(options.focus ? { focus: options.focus } : {}),
			});
			job = finalize(deps, job, bundle, options.signal);
			return { job, bundle: store.readBundle(sourceId), reused: false };
		}

		const result = await ingestWeb(deps, job, classified.canonical, sourceId, options.signal);
		job = result.job;
		if (result.error) return { job: failAndPersist(deps, job, result.error), error: result.error, reused: false };
		const bundle = assembleBundle({
			sourceId,
			kind: "web",
			url: result.work.parts.title ? classified.canonical : classified.canonical,
			work: result.work,
			job,
			retrievedAt: started,
			...(options.focus ? { focus: options.focus } : {}),
		});
		job = finalize(deps, job, bundle, options.signal);
		return { job, bundle: store.readBundle(sourceId), reused: false };
	} catch (error) {
		// A stage that threw already persisted its own accurate state; the local `job` may be several
		// transitions behind. Re-read before writing, or a cancelled run would erase its own progress
		// and a resume would redo work that is already on disk.
		const latest = store.readJob(jobId) ?? job;
		if (error instanceof IngestCancelled || options.signal?.aborted) {
			const cancelledJob = cancelJob(latest, now());
			store.writeJob(cancelledJob);
			return { job: cancelledJob, error: "cancelled", reused: false };
		}
		const message = (error as Error)?.message ?? String(error);
		return { job: failAndPersist(deps, latest, message), error: message, reused: false };
	}
}

function failAndPersist(deps: IngestDeps, job: IngestJob, error: string): IngestJob {
	const failed = failJob(job, error, (deps.now ?? clock)());
	deps.store.writeJob(failed);
	return failed;
}

/** A short, stable-enough suffix for the id of a job that can never be resumed anyway. */
function shortNow(value: number): string {
	return value.toString(36).slice(-6);
}

/** Coverage text for a finished run, so the model reports gaps instead of hiding them. */
export function coverageOf(job: IngestJob): CoverageEntry[] {
	return Object.values(job.stages).map((entry) => ({ ...entry }));
}
