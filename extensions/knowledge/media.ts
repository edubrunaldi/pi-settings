/**
 * knowledge — media toolchain: command builders and output parsers.
 *
 * Pure on purpose. This module builds argv arrays and parses text; it never touches the
 * filesystem, never spawns a process and never imports Pi. `ingest.ts` supplies an `Exec`
 * function (in practice `pi.exec`) and does the file handling, which keeps every gotcha below
 * covered by offline tests.
 *
 * The shapes encoded here were measured on this machine (yt-dlp 2026.10.26, ffmpeg 9.0.2 with
 * the whisper.cpp filter, node 24) and each comment names the failure it prevents:
 *
 * - yt-dlp refuses YouTube without a JS runtime and the remote solver: every YouTube command
 *   carries `--js-runtimes node --remote-components ejs:github`;
 * - `--sub-langs "en.*"` also matches translated tracks (`en-de-DE`, …), which fires dozens of
 *   requests and gets HTTP 429. Languages are picked explicitly from the metadata instead;
 * - the whisper filter writes JSONL (`{start,end,text}` in integer milliseconds), NOT a JSON
 *   document: `JSON.parse` on the whole file throws "Extra data";
 * - ffmpeg filter options containing a Windows drive letter need `C\\:` with forward slashes,
 *   which is fragile — so we run ffmpeg with `cwd` set and pass plain relative names;
 * - uniform sampling (`fps=1/N`) gives frame N the exact timestamp (N-1)*N seconds, while scene
 *   detection needs `showinfo` stderr parsing and its threshold is content-dependent (0.3
 *   selected nothing on a real talking-head video, whose maximum score was 0.059);
 * - exit codes lie: ffmpeg returned 127 for a filter-parse error and yt-dlp exits 1 mid-search,
 *   so callers trust the artifacts, not the code.
 */

import { relative } from "node:path";
import type { TranscriptSegment } from "./types.ts";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/** The subset of `pi.exec` this pipeline needs. Injected so nothing here imports the host. */
export type Exec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<ExecResult>;

/** Required on every YouTube command with current yt-dlp, or the extractor reports "not available". */
export const YT_DLP_JS_FLAGS: readonly string[] = ["--js-runtimes", "node", "--remote-components", "ejs:github"];

/** yt-dlp writes progress to stderr constantly; these lines are noise, not failure. */
export const YT_DLP_NOISE = /\[download\]|Destination:|Merging formats|Deleting original file|impersonation|WARNING: unable to obtain file IO codec/i;

export interface YtDlpInvocation {
	command: string;
	args: string[];
}

/**
 * How to run yt-dlp. The console shim is frequently not on PATH (a user-level pip install puts it
 * under %APPDATA%/Python/.../Scripts), while `python -m yt_dlp` works whenever the module is
 * installed, so the module form is preferred and the shim is the fallback.
 */
export function ytDlpInvocation(options: { python?: string; shim?: string } = {}): YtDlpInvocation {
	const python = options.python ?? (process.platform === "win32" ? "python" : "python3");
	return { command: python, args: ["-m", "yt_dlp"] };
}

export function ytDlpShimInvocation(shim = "yt-dlp"): YtDlpInvocation {
	return { command: shim, args: [] };
}

export function buildMetaArgs(url: string): string[] {
	return [...YT_DLP_JS_FLAGS, "--no-playlist", "--no-warnings", "-J", url];
}

export function buildSubtitleArgs(url: string, langs: string[], outputTemplate = "sub"): string[] {
	if (!langs.length) return [];
	return [
		...YT_DLP_JS_FLAGS,
		"--no-playlist",
		"--skip-download",
		"--write-subs",
		"--write-auto-subs",
		"--sub-langs",
		langs.join(","),
		"--sub-format",
		"json3/vtt/best",
		"-o",
		outputTemplate,
		url,
	];
}

export function buildAudioArgs(url: string, outputTemplate = "audio.%(ext)s"): string[] {
	return [...YT_DLP_JS_FLAGS, "--no-playlist", "-f", "bestaudio/best", "-o", outputTemplate, url];
}

/** Frames need no audio. Prefer a small video-only stream; retain fallbacks for older sources. */
export function buildVideoArgs(url: string, maxHeight = 360, outputTemplate = "video.%(ext)s"): string[] {
	return [
		"--ignore-config",
		...YT_DLP_JS_FLAGS,
		"--no-playlist",
		"--socket-timeout",
		"20",
		"--retries",
		"2",
		"--fragment-retries",
		"2",
		"-f",
		`bestvideo[height<=${maxHeight}]/best[height<=${maxHeight}]/worstvideo/worst`,
		"-o",
		outputTemplate,
		url,
	];
}

/** Metadata keys this pipeline actually reads. Everything else stays in `_sources` untouched. */
export interface VideoMeta {
	id?: string;
	title?: string;
	channel?: string;
	uploader?: string;
	upload_date?: string;
	duration?: number;
	webpage_url?: string;
	language?: string;
	license?: string;
	description?: string;
	subtitles?: Record<string, unknown[]>;
	automatic_captions?: Record<string, unknown[]>;
}

/**
 * Reject translated caption tracks. YouTube's automatic list contains `en`, `en-orig` and dozens
 * of translations such as `en-de-DE`; requesting those fires a request per track and ends in
 * HTTP 429. A usable code has at most one separator, so locales like `pt-BR` survive.
 */
export function isUsableCaptionLanguage(code: string, wanted: string[]): boolean {
	const lower = code.toLowerCase();
	if (lower.split("-").length > 2) return false;
	if (lower.endsWith("-orig")) return true;
	const base = lower.split("-")[0];
	return wanted.some((language) => {
		const wantedLower = language.toLowerCase();
		return lower === wantedLower || base === wantedLower.split("-")[0];
	});
}

export interface SubtitlePlan {
	/** Languages to request, explicit — never a regex. */
	langs: string[];
	origin: TranscriptSegment["origin"];
	/** Why this plan was chosen, for the coverage report. */
	reason: string;
}

/**
 * Choose at most two caption tracks: manual in a wanted language first, then automatic in a
 * wanted language, then automatic English. Requesting more is how a run ends in HTTP 429.
 */
export function planSubtitles(meta: VideoMeta, wantedLanguages: string[]): SubtitlePlan {
	const wanted = wantedLanguages.length ? wantedLanguages : ["en"];
	const videoLanguage = meta.language ? [meta.language] : [];
	const preferred = Array.from(new Set([...videoLanguage, ...wanted]));

	const manual = Object.keys(meta.subtitles ?? {}).filter((code) => isUsableCaptionLanguage(code, preferred));
	if (manual.length) {
		return {
			langs: manual.slice(0, 2),
			origin: "captions",
			reason: `manual captions available: ${manual.slice(0, 2).join(", ")}`,
		};
	}
	const auto = Object.keys(meta.automatic_captions ?? {}).filter((code) => isUsableCaptionLanguage(code, preferred));
	if (auto.length) {
		// Prefer the plain language over its `-orig` variant, so a run does not fetch both.
		const sorted = auto.sort((a, b) => Number(a.includes("-orig")) - Number(b.includes("-orig")) || a.localeCompare(b));
		return {
			langs: sorted.slice(0, 1),
			origin: "auto_captions",
			reason: `no manual captions; automatic track: ${sorted[0]}`,
		};
	}
	const anyAuto = Object.keys(meta.automatic_captions ?? {});
	if (anyAuto.length) {
		const english = anyAuto.find((code) => code.toLowerCase().startsWith("en")) ?? anyAuto[0];
		return { langs: [english], origin: "auto_captions", reason: `no caption in ${preferred.join("/")}; falling back to ${english}` };
	}
	return { langs: [], origin: "auto_captions", reason: "no caption tracks at all — local ASR is the only transcript source" };
}

// ---------------------------------------------------------------- transcript parsing

interface Json3Event {
	tStartMs?: number;
	dDurationMs?: number;
	aAppend?: number;
	segs?: { utf8?: string; tOffsetMs?: number }[];
}

/**
 * YouTube `json3` -> segments.
 *
 * Measured quirks, all handled: the first automatic event carries no `segs` (window metadata);
 * `aAppend: 1` events hold only "\n" and continue the previous caption; some events omit
 * `dDurationMs`, so the next event's start becomes the end; word timing is `tStartMs + tOffsetMs`.
 */
export function parseJson3(text: string, origin: TranscriptSegment["origin"]): TranscriptSegment[] {
	let parsed: { events?: Json3Event[] };
	try {
		parsed = JSON.parse(text) as { events?: Json3Event[] };
	} catch {
		return [];
	}
	const events = Array.isArray(parsed.events) ? parsed.events : [];
	const segments: TranscriptSegment[] = [];

	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (!event || !Array.isArray(event.segs) || !event.segs.length) continue;
		const rawText = event.segs
			.map((seg) => seg.utf8 ?? "")
			.join("")
			.replace(/\s+/g, " ")
			.trim();
		if (!rawText || rawText === "\n") continue;

		const startMs = event.tStartMs ?? 0;
		const durationMs =
			typeof event.dDurationMs === "number" && event.dDurationMs > 0
				? event.dDurationMs
				: Math.max(0, (events[index + 1]?.tStartMs ?? startMs + 2000) - startMs);

		// `aAppend` continues the previous caption line instead of starting a new one.
		if (event.aAppend === 1 && segments.length) {
			const previous = segments.at(-1)!;
			previous.text = `${previous.text} ${rawText}`.replace(/\s+/g, " ").trim();
			previous.end = (startMs + durationMs) / 1000;
			continue;
		}

		const words = event.segs
			.filter((seg) => (seg.utf8 ?? "").trim() && typeof seg.tOffsetMs === "number")
			.map((seg) => ({
				start: (startMs + (seg.tOffsetMs ?? 0)) / 1000,
				end: (startMs + (seg.tOffsetMs ?? 0)) / 1000,
				text: (seg.utf8 ?? "").trim(),
			}));
		segments.push({
			start: startMs / 1000,
			end: (startMs + durationMs) / 1000,
			text: rawText,
			origin,
			...(words.length ? { words } : {}),
		});
	}
	return segments;
}

/** WebVTT -> segments, for sources that only offer VTT. Cue settings and timestamps are dropped. */
export function parseVtt(text: string, origin: TranscriptSegment["origin"]): TranscriptSegment[] {
	const segments: TranscriptSegment[] = [];
	const cuePattern = /(\d{1,2}:)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})([^\n]*)\n([\s\S]*?)(?=\n\s*\n|$)/g;
	let match: RegExpExecArray | null;
	while ((match = cuePattern.exec(text)) !== null) {
		// Group 1 keeps its trailing colon, so strip everything that is not a digit.
		const toSeconds = (h: string | undefined, m: string, s: string, ms: string): number =>
			Number(String(h ?? "0").replace(/[^0-9]/g, "") || 0) * 3600 +
			Number(m) * 60 +
			Number(s) +
			Number(ms) / 1000;
		const start = toSeconds(match[1], match[2], match[3], match[4]);
		const end = toSeconds(match[5], match[6], match[7], match[8]);
		const body = match[10] ?? "";
		const clean = body
			.replace(/<[^>]+>/g, " ")
			.replace(/\{\\[^}]*\}/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (!clean) continue;
		const previous = segments.at(-1);
		if (previous && previous.text === clean && Math.abs(previous.start - start) < 1.5) continue; // rolling auto-caption repeat
		segments.push({ start, end: Math.max(end, start + 0.2), text: clean, origin });
	}
	return segments;
}

/**
 * whisper.cpp JSONL -> segments. One object per line, integer milliseconds.
 * A whole-file `JSON.parse` throws here; a per-line parse also survives a truncated last line.
 */
export function parseWhisperJsonl(text: string): TranscriptSegment[] {
	const segments: TranscriptSegment[] = [];
	for (const line of String(text ?? "").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: { start?: number; end?: number; text?: string };
		try {
			entry = JSON.parse(trimmed) as typeof entry;
		} catch {
			continue;
		}
		const text = (entry.text ?? "").replace(/\s+/g, " ").trim();
		if (!text) continue;
		const start = Number(entry.start ?? 0) / 1000;
		const end = Number(entry.end ?? 0) / 1000;
		segments.push({
			start: Number.isFinite(start) ? start : 0,
			end: Number.isFinite(end) && end > start ? end : start + 1,
			text,
			origin: "asr",
		});
	}
	return segments;
}

/**
 * Merge adjacent segments into readable chunks. Caption tracks are line-based and would otherwise
 * reach the model as thousands of 3-word fragments; ASR segments are ~3s and merge well too.
 * Timestamps stay exact: the chunk spans the first start and the last end.
 */
export function mergeSegments(segments: TranscriptSegment[], targetChars = 220): TranscriptSegment[] {
	const merged: TranscriptSegment[] = [];
	for (const segment of segments) {
		const previous = merged.at(-1);
		const gap = previous ? segment.start - previous.end : Number.POSITIVE_INFINITY;
		if (
			previous &&
			previous.origin === segment.origin &&
			previous.text.length + segment.text.length <= targetChars &&
			gap <= 2.5
		) {
			previous.text = `${previous.text} ${segment.text}`.replace(/\s+/g, " ").trim();
			previous.end = segment.end;
			if (previous.words && segment.words) previous.words = [...previous.words, ...segment.words];
			continue;
		}
		merged.push({ ...segment, ...(segment.words ? { words: [...segment.words] } : {}) });
	}
	return merged;
}

/** Drop the duplicate track yt-dlp writes when two language codes resolve to the same content. */
export function dedupeSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
	const seen = new Set<string>();
	const out: TranscriptSegment[] = [];
	for (const segment of segments) {
		const key = `${segment.start.toFixed(2)}:${segment.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(segment);
	}
	return out;
}

// ---------------------------------------------------------------- ffmpeg

/**
 * Path as a whisper filter option value. Relative is strongly preferred: an absolute Windows path
 * needs its drive colon escaped as `C\\:` with forward slashes, and one mistake surfaces as a
 * misleading "Error opening output file -" instead of a path error.
 */
export function toFilterPath(path: string, fromDir: string): string {
	const rel = relative(fromDir, path).split(/[\\/]/).join("/");
	const value = rel || path.split(/[\\/]/).join("/");
	if (/^[A-Za-z]:/.test(value)) return `${value.slice(0, 1)}\\\\:${value.slice(2)}`;
	return value;
}

export interface WhisperOptions {
	/** Model file name, resolved relative to `cwd` by the caller. */
	model: string;
	language: string;
	translate: boolean;
	/** Output file name, relative to `cwd`. */
	destination: string;
	useGpu?: boolean;
}

/**
 * Build the `whisper` filtergraph. Every path here must be relative: an absolute Windows path
 * needs the drive colon escaped as `C\\:` with forward slashes, and a single mistake surfaces as
 * a misleading "Error opening output file -".
 */
export function whisperFilterString(options: WhisperOptions): string {
	const parts = [
		`model=${options.model}`,
		`language=${options.language || "auto"}`,
		`translate=${options.translate ? "true" : "false"}`,
		"format=json",
		`destination=${options.destination}`,
	];
	if (options.useGpu === false) parts.push("use_gpu=false");
	return `whisper=${parts.join(":")}`;
}

export function buildAsrArgs(input: string, filterString: string): string[] {
	return ["-hide_banner", "-y", "-i", input, "-af", filterString, "-f", "null", "-"];
}

/** Frame N (1-based) of a uniform `fps=1/everySeconds` extraction happens at (N-1)*everySeconds. */
export function uniformFrameTimestamp(frameNumber: number, everySeconds: number): number {
	return Math.max(0, (Math.max(1, frameNumber) - 1) * everySeconds);
}

/**
 * Sampling interval that honours the preferred cadence but widens when the source is long,
 * so the frame count stays under the cap. Never returns 0: `fps=1/0` is not a filter.
 */
export function sampleIntervalSeconds(durationSeconds: number, maxFrames: number, preferredSeconds: number): number {
	const preferred = Math.max(1, Math.round(preferredSeconds));
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return preferred;
	const byCap = Math.ceil(durationSeconds / Math.max(1, Math.round(maxFrames)));
	return Math.max(1, preferred, byCap);
}

export function buildUniformFrameArgs(input: string, everySeconds: number, width: number, outputTemplate: string, quality = 4): string[] {
	return [
		"-hide_banner",
		"-y",
		"-i",
		input,
		"-vf",
		`fps=1/${Math.max(1, Math.round(everySeconds))},scale=${Math.max(64, Math.round(width))}:-2`,
		"-q:v",
		String(quality),
		outputTemplate,
	];
}

export function buildSceneFrameArgs(input: string, threshold: number, width: number, outputTemplate: string, quality = 3): string[] {
	return [
		"-hide_banner",
		"-y",
		"-i",
		input,
		"-vf",
		`select='gt(scene,${threshold})',scale=${Math.max(64, Math.round(width))}:-2,showinfo`,
		"-fps_mode",
		"vfr",
		"-q:v",
		String(quality),
		outputTemplate,
	];
}

/**
 * Timestamps of scene-detected frames, in output order: the k-th `showinfo` line matches
 * `scene_0000k+1.jpg`. Returns an empty array when nothing was detected, which is a normal
 * outcome — a talking-head video can have no scene change above the threshold at all.
 */
export function parseShowinfoTimestamps(stderr: string): number[] {
	const times: number[] = [];
	for (const match of String(stderr ?? "").matchAll(/pts_time:\s*(\d+(?:\.\d+)?)/g)) {
		const value = Number(match[1]);
		if (Number.isFinite(value)) times.push(value);
	}
	return times;
}

/** Duration in seconds from `ffprobe`-style output, or from yt-dlp metadata. */
export function parseFfmpegDuration(stderr: string): number | undefined {
	const match = /Duration:\s*(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/.exec(String(stderr ?? ""));
	if (!match) return undefined;
	return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** Whisper model download URL. `ggerganov/whisper.cpp` on Hugging Face is the canonical mirror. */
export function whisperModelUrl(fileName: string): string {
	return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${fileName}`;
}

export const KNOWN_WHISPER_MODELS: Record<string, { bytes: number; notes: string }> = {
	"ggml-tiny.bin": { bytes: 77_700_000, notes: "fastest, weakest; fine for a smoke test" },
	"ggml-base.bin": { bytes: 148_000_000, notes: "multilingual, good default" },
	"ggml-base.en.bin": { bytes: 148_000_000, notes: "English only, slightly better on English" },
	"ggml-small.bin": { bytes: 488_000_000, notes: "multilingual, noticeably better, slower" },
	"ggml-medium.bin": { bytes: 1_530_000_000, notes: "large download; only for hard audio" },
};

/**
 * curl arguments for the one-time model download.
 *
 * The stall guards matter more than the retry: without `--speed-limit`/`--speed-time` a connection
 * that drops to a trickle keeps going until the caller's timeout, and a measured run once crawled
 * 77 MB of a 148 MB model in 14 minutes while the pipeline looked hung. `-C -` resumes a previous
 * partial file, so a retry does not restart from zero.
 */
export function buildModelDownloadArgs(url: string, destination: string, maxSeconds = 900): string[] {
	return [
		"-L",
		"--fail",
		"--silent",
		"--show-error",
		"--retry",
		"2",
		"--connect-timeout",
		"20",
		"--max-time",
		String(Math.max(60, Math.round(maxSeconds))),
		"--speed-limit",
		"2048",
		"--speed-time",
		"20",
		"-C",
		"-",
		"-o",
		destination,
		url,
	];
}

/** True when stderr/stdout indicates the well-known missing-JS-runtime failure, not a real 404. */
export function looksLikeMissingJsRuntime(output: string): boolean {
	return /not available|Sign in to confirm|JS runtime|nsig|challenge/i.test(output ?? "") && /yt-dlp|YouTube/i.test(output ?? "");
}
