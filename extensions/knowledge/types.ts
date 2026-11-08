/**
 * knowledge — shared types for the persistent knowledge base.
 *
 * These types are the contract between four layers that must stay independently testable:
 *
 *   sources (adapters)  ->  EvidenceBundle   what a source actually contained, with locators
 *   distillation        ->  KnowledgeRecord  what is reusable, in controlled English
 *   store               ->  files on disk    ~/.pi/knowledge, atomic, rebuildable index
 *   retrieval           ->  SearchResult     what a later session can find and trust
 *
 * Invariants that matter across all of them:
 *
 * - A record is never "true", it is *supported*. `validation` keeps three separate axes
 *   (source support, practical test, human review) because a faithful summary of a wrong
 *   video is still wrong, and a working procedure may never have been reviewed.
 * - Every claim carries `evidence` with a locator that points back into `_sources/<id>`,
 *   so an audit can re-read the original wording in its original language.
 * - `status: "contested"` and `conflicts` exist so a new source can disagree with an old
 *   one without silently overwriting it.
 * - Locators are source-kind specific but share one shape, so search and rendering do not
 *   need to know whether the evidence came from a video, an article or a local file.
 *
 * This module has no imports: it is types only, safe to load from anywhere.
 */

/** What kind of reusable knowledge a record holds. Drives which fields are required. */
export type KnowledgeKind =
	| "concept"
	| "procedure"
	| "diagnostic"
	| "reference"
	| "constraint"
	| "comparison";

export const KNOWLEDGE_KINDS: readonly KnowledgeKind[] = [
	"concept",
	"procedure",
	"diagnostic",
	"reference",
	"constraint",
	"comparison",
] as const;

/** Lifecycle of a record. `contested` and `superseded` are kept, never deleted silently. */
export type RecordStatus = "draft" | "active" | "contested" | "superseded";

export const RECORD_STATUSES: readonly RecordStatus[] = [
	"draft",
	"active",
	"contested",
	"superseded",
] as const;

/** How strongly the source backs the claim. */
export type SourceSupport = "demonstrated" | "stated" | "paraphrased" | "inferred" | "none";

export const SOURCE_SUPPORT: readonly SourceSupport[] = [
	"demonstrated",
	"stated",
	"paraphrased",
	"inferred",
	"none",
] as const;

/** Where inside a source a piece of evidence lives. */
export type LocatorKind =
	| "time" // audio/video span, seconds
	| "frame" // extracted image, with its timestamp
	| "section" // heading path in an article or manual
	| "paragraph" // ordinal paragraph inside a section
	| "quote" // verbatim text, original language
	| "code" // code block, with its section
	| "image" // figure in a document, with caption
	| "audio" // non-speech sound (music, noise, machine)
	| "page"; // page number, for paginated documents

export interface EvidenceLocator {
	kind: LocatorKind;
	/** Inclusive start, in seconds from the beginning of the source. */
	start?: number;
	/** Exclusive end, in seconds. Omit for a point locator. */
	end?: number;
	/** Section path, frame file name, page number or figure id. */
	ref?: string;
	/** Short verbatim excerpt in the source language. Never rewritten. */
	quote?: string;
}

export interface Evidence {
	/** Matches `_sources/<sourceId>`. */
	sourceId: string;
	locator: EvidenceLocator;
	/** What the source did with this claim: showed it, said it, or nothing (our inference). */
	support: SourceSupport;
	/** Why this evidence matters, or what it does not cover. */
	note?: string;
}

export interface FailureMode {
	/** The observable signal that something is wrong. */
	signal: string;
	/** Candidate causes, ordered from most to least likely when known. */
	causes: string[];
	/** How to confirm which cause applies. */
	check?: string;
}

export interface ValidationState {
	/** How the source backs this record. */
	sourceSupport: SourceSupport;
	/** Whether the procedure/diagnosis was actually exercised after learning. */
	practicalTest: "not_run" | "passed" | "failed";
	/** Whether a human looked at it. */
	humanReview: "none" | "reviewed";
}

export interface ProductRef {
	name: string;
	/** Version, version range or "any" when the source did not scope it. */
	version?: string;
}

/** One reusable unit of knowledge. Persisted as knowledge.json plus a generated knowledge.md. */
export interface KnowledgeRecord {
	schema: 1;
	/** `<domain>.<topic>.<slug>`, stable across edits. */
	id: string;
	domain: string;
	topic: string;
	kind: KnowledgeKind;
	/** Controlled English, imperative or declarative, <= 80 characters. */
	title: string;
	/** Extra search terms. May keep the source language and colloquial names. */
	aliases: string[];
	/** 1 to 3 sentences, controlled English. This is what retrieval shows first. */
	summary: string;
	/** Longer controlled-English explanation. */
	body?: string;
	/** Conditions under which this record applies. */
	appliesTo: string[];
	/** Conditions under which it must not be applied. */
	doesNotApplyTo: string[];
	/** What must be true or available before the steps run. */
	prerequisites: string[];
	/** One instruction per entry, in execution order. Required for `procedure`. */
	steps: string[];
	expectedResult?: string;
	/** How to check the outcome, or how to observe the thing being diagnosed. */
	verification: string[];
	/** Observable problems and their candidate causes. Required for `diagnostic`. */
	failureModes: FailureMode[];
	constraints: string[];
	product?: ProductRef;
	/** Preferred terms used, so a glossary can keep naming consistent. */
	terms: string[];
	evidence: Evidence[];
	validation: ValidationState;
	status: RecordStatus;
	/** Record ids this one replaces. */
	supersedes: string[];
	/** Record ids that disagree, with the reason. */
	conflicts: { recordId: string; note: string }[];
	/** Source ids that contributed. */
	sources: string[];
	/** What the source did NOT cover, so absence of evidence is not read as evidence of absence. */
	coverageGaps?: string;
	createdAt: number;
	updatedAt: number;
}

/** Kinds of sources the adapters understand. */
export type SourceKind = "youtube" | "web" | "file";

export type SourceState =
	| "queued"
	| "running"
	| "evidence_ready" // mechanical extraction finished, waiting for distillation
	| "distilled" // at least one record written from it
	| "failed"
	| "cancelled";

export interface TranscriptSegment {
	/** Seconds from the start of the source. */
	start: number;
	end: number;
	text: string;
	/** Which track produced it: captions, auto captions or local ASR. */
	origin: "captions" | "auto_captions" | "asr";
	/** Word-level timings when the track provided them. */
	words?: { start: number; end: number; text: string }[];
}

export interface FrameRef {
	/** File name inside `_sources/<id>/assets/`. */
	file: string;
	/** Seconds from the start of the source. */
	at: number;
	/** Why this frame was kept. */
	reason: "scene_change" | "sample" | "speech_reference";
	/** Scene-change score when known. */
	score?: number;
	width?: number;
	height?: number;
	bytes?: number;
}

/** Everything mechanical extraction produced for one source. Input to distillation. */
export interface EvidenceBundle {
	schema: 1;
	sourceId: string;
	kind: SourceKind;
	state: SourceState;
	url?: string;
	path?: string;
	title?: string;
	author?: string;
	publishedAt?: string;
	retrievedAt: number;
	durationSeconds?: number;
	language?: string;
	/** What the caller asked to pay attention to. Carried through so distillation stays on target. */
	focus?: string;
	/** Provenance of the transcript, so confidence can be judged. */
	transcript?: {
		origin: TranscriptSegment["origin"];
		language?: string;
		/** Which track was chosen and why, straight from the coverage report. */
		note?: string;
		segmentCount: number;
		segments: TranscriptSegment[];
		/** True when the transcript covers only part of the media. */
		partial?: boolean;
	};
	frames?: FrameRef[];
	/** Article/document text, split into sections with their headings. */
	sections?: { heading: string; level: number; text: string; index: number }[];
	images?: { file: string; caption?: string; section?: string }[];
	codeBlocks?: { language?: string; code: string; section?: string }[];
	/** Non-speech audio observations, when a model analysed the audio itself. */
	audioNotes?: { start: number; end: number; note: string }[];
	/** Every stage's outcome, including what was skipped and why. */
	coverage: CoverageEntry[];
	/** Hard limits that truncated the work. */
	limits?: string[];
	error?: string;
}

export interface CoverageEntry {
	stage: string;
	status: "done" | "skipped" | "failed" | "partial";
	detail?: string;
	/** Milliseconds spent, when known. */
	ms?: number;
}

/** One ingestion job. Persisted under `_jobs/<id>.json` so an interrupted run can resume. */
export interface IngestJob {
	schema: 1;
	id: string;
	sourceId: string;
	kind: SourceKind;
	target: string; // url or path
	state: SourceState;
	stage: string;
	stages: Record<string, CoverageEntry>;
	createdAt: number;
	updatedAt: number;
	/** Fingerprint of target + options, so the same request is not processed twice. */
	fingerprint: string;
	error?: string;
	/** Record ids produced from this job. */
	records: string[];
}

export interface MediaLimits {
	/** Refuse sources longer than this. */
	maxDurationSeconds: number;
	maxHtmlBytes: number;
	maxFrames: number;
	frameWidth: number;
	sceneThreshold: number;
	sampleEverySeconds: number;
	/** Transcription model file name under the model cache. */
	whisperModel: string;
	whisperLanguage: string;
	whisperTranslate: boolean;
	/** What to keep after extraction: frames are always kept, this controls the heavy media. */
	keepMedia: "none" | "audio" | "all";
	/** Characters of transcript handed to the model per evidence page. */
	transcriptPageChars: number;
	searchTopK: number;
	/** Seconds a single external command may run. */
	commandTimeoutSeconds: number;
}

export interface KnowledgeConfig {
	/** Root of the knowledge base. Defaults to ~/.pi/knowledge. */
	root: string;
	limits: MediaLimits;
	/** Domain names are open, but these are offered first when the model must choose. */
	domains: string[];
	/** Preferred terms per domain: { domain: { "preferred": ["alias", ...] } }. */
	glossary: Record<string, Record<string, string[]>>;
}

export interface SearchResult {
	id: string;
	domain: string;
	topic: string;
	kind: KnowledgeKind;
	title: string;
	summary: string;
	status: RecordStatus;
	score: number;
	/** Fields that matched, so the model can say why this came up. */
	matched: string[];
	product?: ProductRef;
	validation: ValidationState;
	path: string;
}
