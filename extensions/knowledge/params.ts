/**
 * knowledge — tool parameter schemas.
 *
 * One tool, one `action` discriminator, so a session pays for a single declaration instead of
 * eight. The per-action fields are optional at the schema level on purpose: `logic.ts` refuses a
 * bad call with a message that names the exact rule ("a procedure needs at least 1 step"), which
 * is more useful to a model than a generic schema rejection, and it keeps coercion in one place.
 *
 * The schema still documents every field, because the declaration is what the model reads.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { KNOWLEDGE_KINDS, RECORD_STATUSES, SOURCE_SUPPORT } from "./types.ts";

export const ACTIONS = [
	"learn",
	"evidence",
	"write",
	"search",
	"read",
	"jobs",
	"cancel",
	"sources",
	"config",
] as const;

const LOCATOR_SCHEMA = Type.Object({
	kind: StringEnum(["time", "frame", "section", "paragraph", "quote", "code", "image", "audio", "page"] as const, {
		description:
			'Where inside the source this lives. "time"/"audio" use seconds, "frame" uses ref + start, ' +
			'"section"/"paragraph"/"code"/"image" use ref, "quote" carries the verbatim text.',
	}),
	start: Type.Optional(Type.Number({ description: "Start in seconds from the beginning of the source." })),
	end: Type.Optional(Type.Number({ description: "End in seconds, exclusive. Must be greater than start." })),
	ref: Type.Optional(
		Type.String({ description: 'Section heading, frame file name, page number or figure id, e.g. "f012.jpg".' }),
	),
	quote: Type.Optional(
		Type.String({
			description:
				"Verbatim excerpt in the source language, at most 280 characters. Never rewrite it: this is the audit trail.",
		}),
	),
});

const EVIDENCE_SCHEMA = Type.Object({
	sourceId: Type.String({ description: "The source this came from, e.g. youtube-VIDEOID or web-example.com-abc123." }),
	locator: LOCATOR_SCHEMA,
	support: Type.Optional(
		StringEnum(SOURCE_SUPPORT, {
			description:
				'"demonstrated" = the source showed it, "stated" = the source said it, "paraphrased" = you restated it, ' +
				'"inferred" = you concluded it and the source did not say it. Default "paraphrased".',
		}),
	),
	note: Type.Optional(Type.String({ description: "What this evidence does or does not prove, at most 240 characters." })),
});

const RECORD_SCHEMA = Type.Object(
	{
		id: Type.Optional(
			Type.String({
				description:
					"Stable id `<domain>.<topic>.<slug>`. Omit it to derive one from domain, topic and title; reuse an " +
					"existing id to update that record instead of creating a near-duplicate.",
			}),
		),
		domain: Type.String({ description: "Domain slug, e.g. animation, programming, tooling. Lowercase, no spaces." }),
		topic: Type.String({ description: "Topic slug inside the domain, e.g. character-rigging, sql-performance." }),
		kind: StringEnum(KNOWLEDGE_KINDS, {
			description:
				"concept = what it is; procedure = how to do it; diagnostic = how to recognise and explain a problem; " +
				"reference = parameters and commands; constraint = a limitation; comparison = how options differ.",
		}),
		title: Type.String({ description: "Controlled English, at most 80 characters. Imperative for a procedure." }),
		summary: Type.String({
			description: "1 to 3 sentences, at most 600 characters. This is what a later session reads first.",
		}),
		aliases: Type.Optional(
			Type.Array(Type.String(), { description: "Extra search terms, including source-language and colloquial names." }),
		),
		body: Type.Optional(Type.String({ description: "Longer controlled-English explanation, at most 8000 characters." })),
		appliesTo: Type.Optional(Type.Array(Type.String(), { description: "Conditions under which this record applies." })),
		doesNotApplyTo: Type.Optional(
			Type.Array(Type.String(), { description: "Conditions under which it must NOT be applied. State these explicitly." }),
		),
		prerequisites: Type.Optional(Type.Array(Type.String(), { description: "What must be true or available first." })),
		steps: Type.Optional(
			Type.Array(Type.String(), {
				description: "One instruction per entry, in execution order, at most 240 characters each. Required for a procedure.",
			}),
		),
		expectedResult: Type.Optional(
			Type.String({ description: "What a correct run produces. Required for a procedure unless verification is given." }),
		),
		verification: Type.Optional(
			Type.Array(Type.String(), { description: "How to check the outcome, or what to observe when diagnosing." }),
		),
		failureModes: Type.Optional(
			Type.Array(
				Type.Object({
					signal: Type.String({ description: "The observable symptom, at most 200 characters." }),
					causes: Type.Array(Type.String(), { description: "Candidate causes, most likely first." }),
					check: Type.Optional(Type.String({ description: "How to confirm which cause applies." })),
				}),
			),
			{ description: "Required for a diagnostic: at least one entry with a signal." },
		),
		constraints: Type.Optional(Type.Array(Type.String(), { description: "Hard limits: versions, units, quotas, incompatibilities." })),
		product: Type.Optional(
			Type.Object({
				name: Type.String({ description: "Product or library name, e.g. Blender, PostgreSQL." }),
				version: Type.Optional(Type.String({ description: 'Version or range the source scoped this to, or "any".' })),
			}),
		),
		terms: Type.Optional(Type.Array(Type.String(), { description: "Preferred terms used, so naming stays consistent." })),
		evidence: Type.Array(EVIDENCE_SCHEMA, {
			minItems: 1,
			description:
				"At least one citation with a locator. A record with no locator is an opinion and will be refused.",
		}),
		validation: Type.Optional(
			Type.Object({
				sourceSupport: Type.Optional(StringEnum(SOURCE_SUPPORT, { description: 'How the source backs this. Default "paraphrased".' })),
				practicalTest: Type.Optional(
					StringEnum(["not_run", "passed", "failed"] as const, {
						description: 'Did you actually exercise this after learning it? Default "not_run" — do not claim "passed" without a run.',
					}),
				),
				humanReview: Type.Optional(StringEnum(["none", "reviewed"] as const, { description: 'Default "none".' })),
			}),
		),
		status: Type.Optional(
			StringEnum(RECORD_STATUSES, {
				description:
					'default "active". Use "draft" when evidence is thin, "contested" when a source disagrees with an existing ' +
					'record, "superseded" when a newer record replaces this one.',
			}),
		),
		supersedes: Type.Optional(Type.Array(Type.String(), { description: "Record ids this one replaces." })),
		conflicts: Type.Optional(
			Type.Array(
				Type.Object({
					recordId: Type.String(),
					note: Type.String({ description: "What the disagreement is, and which source says what." }),
				}),
			),
			{ description: "Never overwrite a disagreement silently: record it here and set status to contested." },
		),
		coverageGaps: Type.Optional(
			Type.String({
				description:
					"What the source did NOT cover, at most 600 characters. Absence of evidence must not read as evidence of absence.",
			}),
		),
	},
	{ description: "One reusable unit of knowledge, in controlled English, with citations." },
);

export const KNOWLEDGE_PARAMS = Type.Object({
	action: StringEnum(ACTIONS, {
		description:
			"learn = ingest a source; evidence = read a page of what was extracted (transcript, sections, frames); " +
			"write = save one knowledge record; search = find records; read = open one record; jobs = ingestion state; " +
			"cancel = stop a job; sources = list ingested sources; config = show or change limits.",
	}),

	// learn
	target: Type.Optional(
		Type.String({
			description:
				"learn: what to ingest. An http(s) URL, `yt:<videoId>`, a YouTube URL, or `file:<absolute path>` for local " +
				"media or text. Only http and https are ever fetched.",
		}),
	),
	domain: Type.Optional(
		Type.String({ description: "learn/write/search: domain slug. For learn it seeds the records you are expected to write." }),
	),
	topic: Type.Optional(Type.String({ description: "learn/write: topic slug inside the domain." })),
	focus: Type.Optional(
		Type.String({
			description:
				"learn: what to pay attention to, e.g. \"the foot-contact fix\". Narrows the evidence pages you should read first.",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description:
				"learn: re-ingest even when a finished job already exists for this target and these limits. " +
				"Without it, a repeated request reuses the existing evidence and finished stages are never redone.",
		}),
	),

	// evidence
	source: Type.Optional(Type.String({ description: "evidence: sourceId, as reported by learn or sources." })),
	transcriptFrom: Type.Optional(
		Type.Number({ description: "evidence: segment index to start the transcript page at. Default 0; use nextIndex to page." }),
	),
	transcriptChars: Type.Optional(Type.Number({ description: "evidence: max characters of transcript for this page." })),
	sections: Type.Optional(
		Type.Array(Type.Number(), { description: "evidence: section indexes to return from a document source." }),
	),
	frames: Type.Optional(
		Type.Array(Type.Number(), {
			description:
				"evidence: frame indexes to return as images, e.g. [0,4,9]. At most 8 per call; each frame is downscaled.",
			maxItems: 8,
		}),
	),

	// write
	record: Type.Optional(RECORD_SCHEMA),

	// search / read
	query: Type.Optional(Type.String({ description: "search: words to look for." })),
	kind: Type.Optional(StringEnum(KNOWLEDGE_KINDS, { description: "search: restrict to one kind." })),
	status: Type.Optional(StringEnum(RECORD_STATUSES, { description: "search: restrict to one status." })),
	product: Type.Optional(Type.String({ description: "search: restrict to records scoped to this product." })),
	limit: Type.Optional(Type.Number({ description: "search: max results. Default from config." })),
	id: Type.Optional(Type.String({ description: "read/jobs/cancel: record id or job id." })),

	// config
	config: Type.Optional(
		Type.Object(
			{
				limits: Type.Optional(
					Type.Object(
						{
							maxDurationSeconds: Type.Optional(Type.Number()),
							maxFrames: Type.Optional(Type.Number()),
							frameWidth: Type.Optional(Type.Number()),
							sceneThreshold: Type.Optional(Type.Number()),
							sampleEverySeconds: Type.Optional(Type.Number()),
							whisperModel: Type.Optional(Type.String()),
							whisperLanguage: Type.Optional(Type.String()),
							whisperTranslate: Type.Optional(Type.Boolean()),
							keepMedia: Type.Optional(StringEnum(["none", "audio", "all"] as const)),
							transcriptPageChars: Type.Optional(Type.Number()),
							searchTopK: Type.Optional(Type.Number()),
							commandTimeoutSeconds: Type.Optional(Type.Number()),
						},
						{ additionalProperties: false },
					),
				),
				domains: Type.Optional(Type.Array(Type.String())),
				glossary: Type.Optional(
					Type.Record(Type.String(), Type.Record(Type.String(), Type.Array(Type.String())), {
						description:
							'Preferred terms per domain: { "animation": { "foot contact": ["foot plant", "plant"] } }. ' +
							"A record using an alias gets a style note pointing at the preferred term.",
					}),
				),
			},
			{ additionalProperties: false, description: "config: settings to merge. Omit to show the current config." },
		),
	),
});
