/**
 * knowledge — the store: everything that touches the filesystem.
 *
 * Layout under the knowledge root (default `~/.pi/knowledge`, override with `PI_KNOWLEDGE_DIR`):
 *
 *   _config.json                 limits, domains, glossary
 *   _sources/<sourceId>/         evidence.json + assets/ (frames, kept media, document images)
 *   _jobs/<jobId>.json           resumable ingestion state
 *   _models/<ggml-*.bin>         local ASR models
 *   _index/index.json            rebuildable manifest — never the only copy of anything
 *   <domain>/<topic>/<slug>/     knowledge.json (canonical) + knowledge.md (generated)
 *
 * Invariants:
 * - JSON is the source of truth and Markdown is generated from it, so the two cannot drift;
 * - writes are atomic (temp file + rename). An interrupted ingestion leaves either the old
 *   file or the new one, never a half-written record that reads as complete;
 * - the index is derived. Deleting `_index/` costs a rescan, not knowledge;
 * - a corrupt file is reported with its path and skipped, so one bad record cannot make the
 *   whole library unreadable;
 * - heavy media is prunable by policy (`limits.keepMedia`); frames and evidence.json are not,
 *   because they are what makes a citation checkable later.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultConfig, mergeConfig, slugify } from "./logic.ts";
import { renderRecordMarkdown } from "./render.ts";
import type { EvidenceBundle, IngestJob, KnowledgeConfig, KnowledgeRecord } from "./types.ts";

export const CONFIG_FILE = "_config.json";
export const SOURCES_DIR = "_sources";
export const JOBS_DIR = "_jobs";
export const MODELS_DIR = "_models";
export const INDEX_DIR = "_index";
export const ASSETS_DIR = "assets";
export const BUNDLE_FILE = "evidence.json";
export const RECORD_FILE = "knowledge.json";
export const RECORD_MARKDOWN = "knowledge.md";
export const INDEX_FILE = "index.json";

/** Reserved directory names: a domain may never collide with the store's own furniture. */
const RESERVED = new Set([SOURCES_DIR, JOBS_DIR, MODELS_DIR, INDEX_DIR, "_glossary", "_cache"]);

let writeCounter = 0;

function tempPathFor(target: string): string {
	writeCounter += 1;
	return `${target}.tmp-${process.pid}-${writeCounter}`;
}

/** Write JSON atomically: temp file in the same directory, then rename over the target. */
export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = tempPathFor(path);
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temp, path);
}

export function writeTextAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = tempPathFor(path);
	writeFileSync(temp, text, "utf8");
	renameSync(temp, path);
}

export interface JsonRead<T> {
	value?: T;
	error?: string;
}

/** Read JSON without throwing on a missing or corrupt file: the caller decides what that means. */
export function readJsonSafe<T>(path: string): JsonRead<T> {
	if (!existsSync(path)) return { error: "missing" };
	try {
		return { value: JSON.parse(readFileSync(path, "utf8")) as T };
	} catch (error) {
		return { error: `${path}: ${(error as Error).message}` };
	}
}

/**
 * Knowledge root resolution, in priority order:
 * 1. `PI_KNOWLEDGE_DIR` — an operator override that always wins (tests, a second library);
 * 2. `root` in `_config.json` at the derived location — lets a user relocate the library;
 * 3. `~/.pi/knowledge`, derived from the agent dir so a rebranded Pi keeps its own layout.
 */
export function resolveKnowledgeRoot(): string {
	const fromEnv = process.env.PI_KNOWLEDGE_DIR;
	if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());

	let base: string;
	try {
		const agentDir = getAgentDir();
		base = join(dirname(resolve(agentDir)), "knowledge");
	} catch {
		base = join(homedir(), ".pi", "knowledge");
	}
	const configured = readJsonSafe<{ root?: unknown }>(join(base, CONFIG_FILE));
	if (configured.value && typeof configured.value.root === "string" && configured.value.root.trim()) {
		return resolve(configured.value.root.trim());
	}
	return base;
}

export interface IndexEntry {
	id: string;
	path: string;
	domain: string;
	topic: string;
	slug: string;
	kind: KnowledgeRecord["kind"];
	title: string;
	status: KnowledgeRecord["status"];
	updatedAt: number;
	product?: KnowledgeRecord["product"];
	validation: KnowledgeRecord["validation"];
	summary: string;
	aliases: string[];
	terms: string[];
}

export interface RecordPaths {
	dir: string;
	json: string;
	markdown: string;
}

export interface AssetRead {
	data?: string;
	mimeType?: string;
	bytes?: number;
	error?: string;
}

export interface KnowledgeStore {
	root: string;
	config: KnowledgeConfig;
	ensureLayout(): void;
	reloadConfig(): KnowledgeConfig;
	saveConfigPatch(patch: unknown): { ok: true; config: KnowledgeConfig } | { ok: false; error: string };

	sourceDir(sourceId: string): string;
	assetsDir(sourceId: string): string;
	assetPath(sourceId: string, file: string): string;
	writeBundle(bundle: EvidenceBundle): string;
	readBundle(sourceId: string): EvidenceBundle | undefined;
	listSourceIds(): string[];
	readAssetBase64(sourceId: string, file: string, maxBytes: number): AssetRead;
	pruneMedia(sourceId: string, keep: string[]): string[];

	modelPath(fileName: string): string;

	recordPaths(record: Pick<KnowledgeRecord, "id" | "domain" | "topic" | "title">): RecordPaths;
	writeRecord(record: KnowledgeRecord): RecordPaths;
	readRecord(id: string): KnowledgeRecord | undefined;
	recordExists(id: string): boolean;
	listRecords(filter?: { domain?: string; kind?: string }): KnowledgeRecord[];

	rebuildIndex(): { count: number; path: string };
	loadIndex(): IndexEntry[];

	writeJob(job: IngestJob): void;
	readJob(id: string): IngestJob | undefined;
	listJobs(): IngestJob[];
	findJobByFingerprint(fingerprint: string): IngestJob | undefined;
}

function mimeTypeFor(file: string): string {
	const lower = file.toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	return "application/octet-stream";
}

/** `<domain>/<topic>/<slug>` — the id already carries the first three parts, so nothing is duplicated. */
function pathsForRecord(root: string, record: Pick<KnowledgeRecord, "id" | "domain" | "topic" | "title">): RecordPaths {
	const prefix = `${record.domain}.${record.topic}.`;
	const slug = record.id.startsWith(prefix) && record.id.length > prefix.length
		? record.id.slice(prefix.length)
		: slugify(record.title, 40) || slugify(record.id, 40) || "record";
	const dir = join(root, record.domain, record.topic, slug);
	return { dir, json: join(dir, RECORD_FILE), markdown: join(dir, RECORD_MARKDOWN) };
}

export function createStore(rootOverride?: string): KnowledgeStore {
	const root = resolve(rootOverride?.trim() ? rootOverride.trim() : resolveKnowledgeRoot());
	let config: KnowledgeConfig = defaultConfig(root);

	function configPath(): string {
		return join(root, CONFIG_FILE);
	}

	function ensureLayout(): void {
		for (const dir of [root, join(root, SOURCES_DIR), join(root, JOBS_DIR), join(root, MODELS_DIR), join(root, INDEX_DIR)]) {
			mkdirSync(dir, { recursive: true });
		}
	}

	function reloadConfig(): KnowledgeConfig {
		const read = readJsonSafe<unknown>(configPath());
		if (!read.value) {
			config = defaultConfig(root);
			return config;
		}
		const merged = mergeConfig(defaultConfig(root), read.value);
		if (!merged.ok) {
			// A broken config must not silently become the defaults: keep defaults, surface the error.
			config = { ...defaultConfig(root), domains: defaultConfig(root).domains };
			config.glossary = {};
			(config as KnowledgeConfig & { configError?: string }).configError = merged.error;
			return config;
		}
		config = { ...merged.config, root };
		return config;
	}

	function saveConfigPatch(patch: unknown): { ok: true; config: KnowledgeConfig } | { ok: false; error: string } {
		const current = readJsonSafe<Record<string, unknown>>(configPath()).value ?? {};
		const merged = mergeConfig(defaultConfig(root), { ...current, ...(typeof patch === "object" && patch ? patch : {}) });
		if (!merged.ok) return merged;
		ensureLayout();
		const persisted = { ...merged.config };
		delete (persisted as { root?: string }).root;
		writeJsonAtomic(configPath(), persisted);
		config = { ...merged.config, root };
		return { ok: true, config };
	}

	function sourceDir(sourceId: string): string {
		return join(root, SOURCES_DIR, sourceId);
	}

	function listRecordDirs(): RecordPaths[] {
		const out: RecordPaths[] = [];
		if (!existsSync(root)) return out;
		for (const domain of readdirSync(root)) {
			if (RESERVED.has(domain) || domain.startsWith("_") || domain.startsWith(".")) continue;
			const domainPath = join(root, domain);
			if (!statSync(domainPath).isDirectory()) continue;
			for (const topic of readdirSync(domainPath)) {
				const topicPath = join(domainPath, topic);
				if (!statSync(topicPath).isDirectory()) continue;
				for (const slug of readdirSync(topicPath)) {
					const dir = join(topicPath, slug);
					if (!statSync(dir).isDirectory()) continue;
					const json = join(dir, RECORD_FILE);
					if (existsSync(json)) out.push({ dir, json, markdown: join(dir, RECORD_MARKDOWN) });
				}
			}
		}
		return out;
	}

	const recordCache = new Map<string, { mtimeMs: number; size: number; record: KnowledgeRecord }>();

	function readRecordFrom(paths: RecordPaths): KnowledgeRecord | undefined {
		try {
			const stats = statSync(paths.json);
			const cached = recordCache.get(paths.json);
			if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.record;
			const read = readJsonSafe<KnowledgeRecord>(paths.json);
			if (!read.value) return undefined;
			recordCache.set(paths.json, { mtimeMs: stats.mtimeMs, size: stats.size, record: read.value });
			return read.value;
		} catch {
			return undefined;
		}
	}

	const store: KnowledgeStore = {
		root,
		// A getter, not a snapshot: reloadConfig() and saveConfigPatch() rebind the local, and every
		// caller must see the current limits instead of the ones read at construction time.
		get config(): KnowledgeConfig {
			return config;
		},
		ensureLayout,
		reloadConfig,
		saveConfigPatch,

		sourceDir,
		assetsDir: (sourceId) => join(sourceDir(sourceId), ASSETS_DIR),
		assetPath: (sourceId, file) => join(sourceDir(sourceId), ASSETS_DIR, file),

		writeBundle(bundle) {
			ensureLayout();
			const path = join(sourceDir(bundle.sourceId), BUNDLE_FILE);
			writeJsonAtomic(path, bundle);
			return path;
		},

		readBundle(sourceId) {
			return readJsonSafe<EvidenceBundle>(join(sourceDir(sourceId), BUNDLE_FILE)).value;
		},

		listSourceIds() {
			const dir = join(root, SOURCES_DIR);
			if (!existsSync(dir)) return [];
			return readdirSync(dir).filter((entry) => statSync(join(dir, entry)).isDirectory());
		},

		readAssetBase64(sourceId, file, maxBytes) {
			// A path must stay inside this source's assets dir: `..` would turn a citation into a read primitive.
			const path = resolve(join(sourceDir(sourceId), ASSETS_DIR, file));
			const allowed = resolve(join(sourceDir(sourceId), ASSETS_DIR));
			if (!path.startsWith(allowed)) return { error: "asset path escapes the source directory" };
			if (!existsSync(path)) return { error: `asset not found: ${file}` };
			const bytes = statSync(path).size;
			if (bytes > maxBytes) return { error: `asset is ${bytes} bytes, above the ${maxBytes} byte limit`, bytes };
			return { data: readFileSync(path).toString("base64"), mimeType: mimeTypeFor(path), bytes };
		},

		pruneMedia(sourceId, keep) {
			const assets = join(sourceDir(sourceId), ASSETS_DIR);
			if (!existsSync(assets)) return [];
			const keepSet = new Set(keep);
			const removed: string[] = [];
			for (const file of readdirSync(assets)) {
				if (keepSet.has(file)) continue;
				// Only heavy containers are prunable. Frames, transcripts and document images stay.
				if (!/\.(m4a|webm|mp4|mkv|opus|wav|mp3|flv|avi)$/i.test(file)) continue;
				try {
					rmSync(join(assets, file), { force: true });
					removed.push(file);
				} catch {
					/* a locked file is not fatal: retention is best effort */
				}
			}
			return removed;
		},

		modelPath: (fileName) => join(root, MODELS_DIR, fileName),

		recordPaths: (record) => pathsForRecord(root, record),

		writeRecord(record) {
			ensureLayout();
			const paths = pathsForRecord(root, record);
			writeJsonAtomic(paths.json, record);
			writeTextAtomic(paths.markdown, renderRecordMarkdown(record));
			recordCache.delete(paths.json);
			return paths;
		},

		readRecord(id) {
			const [domain, topic] = id.split(".");
			if (!domain || !topic) return undefined;
			for (const paths of listRecordDirs()) {
				const record = readRecordFrom(paths);
				if (record?.id === id) return record;
			}
			return undefined;
		},

		recordExists(id) {
			return store.readRecord(id) !== undefined;
		},

		listRecords(filter) {
			const records: KnowledgeRecord[] = [];
			for (const paths of listRecordDirs()) {
				const record = readRecordFrom(paths);
				if (!record) continue;
				if (filter?.domain && record.domain !== filter.domain) continue;
				if (filter?.kind && record.kind !== filter.kind) continue;
				records.push(record);
			}
			return records;
		},

		rebuildIndex() {
			ensureLayout();
			const entries: IndexEntry[] = [];
			for (const paths of listRecordDirs()) {
				const record = readRecordFrom(paths);
				if (!record) continue;
				const prefix = `${record.domain}.${record.topic}.`;
				entries.push({
					id: record.id,
					path: paths.dir,
					domain: record.domain,
					topic: record.topic,
					slug: record.id.startsWith(prefix) ? record.id.slice(prefix.length) : record.id,
					kind: record.kind,
					title: record.title,
					status: record.status,
					updatedAt: record.updatedAt,
					...(record.product ? { product: record.product } : {}),
					validation: record.validation,
					summary: record.summary,
					aliases: record.aliases,
					terms: record.terms,
				});
			}
			entries.sort((a, b) => a.id.localeCompare(b.id));
			const path = join(root, INDEX_DIR, INDEX_FILE);
			writeJsonAtomic(path, { schema: 1, generatedAt: Date.now(), count: entries.length, entries });
			return { count: entries.length, path };
		},

		loadIndex() {
			const read = readJsonSafe<{ entries?: IndexEntry[] }>(join(root, INDEX_DIR, INDEX_FILE));
			return read.value?.entries ?? [];
		},

		writeJob(job) {
			ensureLayout();
			writeJsonAtomic(join(root, JOBS_DIR, `${job.id}.json`), job);
		},

		readJob(id) {
			const safe = slugify(id, 80);
			if (!safe) return undefined;
			return readJsonSafe<IngestJob>(join(root, JOBS_DIR, `${safe}.json`)).value;
		},

		listJobs() {
			const dir = join(root, JOBS_DIR);
			if (!existsSync(dir)) return [];
			const jobs: IngestJob[] = [];
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".json")) continue;
				const job = readJsonSafe<IngestJob>(join(dir, file)).value;
				if (job) jobs.push(job);
			}
			jobs.sort((a, b) => b.updatedAt - a.updatedAt);
			return jobs;
		},

		findJobByFingerprint(fingerprint) {
			return store.listJobs().find((job) => job.fingerprint === fingerprint);
		},
	};

	reloadConfig();
	return store;
}
