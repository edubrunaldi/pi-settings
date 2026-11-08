/**
 * knowledge — the `web` adapter: fetch one document the user pointed at, and turn it into
 * locatable evidence.
 *
 * Deliberately narrow: this is NOT a crawler. One URL, one request, no link following, no
 * pagination, no scraping of neighbours. A user pointing the tool at a page is the authorization;
 * anything beyond that page is out of scope.
 *
 * `tokenizeBlocks()` and `extractDocument()` are pure (string in, structure out), so extraction
 * quality is testable offline. `fetchDocument()` is the only part that touches the network.
 *
 * Why a tokenizer and not paired-tag regexes: a pattern like `<(div|p)[^>]*>([\s\S]*?)</\1>` matches
 * the outermost container first and its lazy body swallows every nested paragraph, so the next
 * match starts after all of them. On a real static Sphinx page (466 KB, 39 paragraphs) that
 * produced zero text. A single pass over tags with an explicit stack has no nesting hazard, and it
 * carries the two decisions that matter per element: is it chrome (skip its subtree), and is it
 * inside a landmark (prefer that content).
 *
 * Extraction is still heuristic and says so. A page that renders its text with JavaScript yields
 * almost no text and is reported as such instead of being presented as a learned article.
 *
 * Fetched text is untrusted input. It is never executed, never interpreted as instructions, and
 * reaches the model only through `wrapUntrusted()`.
 */

import { classifyTarget } from "./logic.ts";

export interface WebSection {
	heading: string;
	level: number;
	text: string;
	index: number;
}

export interface WebImage {
	src: string;
	alt?: string;
	caption?: string;
	section?: string;
	width?: number;
	height?: number;
}

export interface WebCodeBlock {
	language?: string;
	code: string;
	section?: string;
	index: number;
}

export interface WebDocument {
	url: string;
	finalUrl: string;
	status: number;
	title?: string;
	author?: string;
	publishedAt?: string;
	language?: string;
	sections: WebSection[];
	images: WebImage[];
	codeBlocks: WebCodeBlock[];
	htmlBytes: number;
	charCount: number;
	warnings: string[];
}

const USER_AGENT = "Mozilla/5.0 (compatible; Pi-Knowledge/1.0; personal knowledge base; single-request fetch)";

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ensp: " ",
	emsp: " ",
	thinsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	copy: "©",
	reg: "®",
	trade: "™",
	deg: "°",
	times: "×",
	divide: "÷",
	plusmn: "±",
	middot: "·",
	bull: "•",
	rarr: "→",
	larr: "←",
	uarr: "↑",
	darr: "↓",
	harr: "↔",
	eacute: "é",
	egrave: "è",
	agrave: "à",
	ccedil: "ç",
	ntilde: "ñ",
	uuml: "ü",
	ouml: "ö",
	auml: "ä",
	szlig: "ß",
	euro: "€",
	pound: "£",
	yen: "¥",
	cent: "¢",
	sect: "§",
	para: "¶",
	permil: "‰",
	frac12: "½",
	frac14: "¼",
	frac34: "¾",
	sup2: "²",
	sup3: "³",
	micro: "µ",
};

export function decodeEntities(text: string): string {
	return String(text ?? "")
		.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, decimal: string) => safeCodePoint(Number(decimal)))
		.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
	if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
	try {
		return String.fromCodePoint(code);
	} catch {
		return "";
	}
}

/** Collapse whitespace inside a text run, keeping real paragraph breaks as blank lines. */
function normalizeText(text: string): string {
	return decodeEntities(text)
		.replace(/\u00a0/g, " ")
		.replace(/[ \t\r\f\v]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Elements whose whole subtree is never prose. Removed before tokenizing: they cannot nest themselves. */
const DROPPED_TAGS = ["script", "style", "noscript", "template", "svg", "iframe", "object", "embed", "canvas", "form", "button", "select", "textarea"];

const CHROME_PATTERN =
	/(nav|navbar|menu|megamenu|sidebar|side-bar|footer|foot|header|masthead|banner|breadcrumb|comment|comments|disqus|related|recommended|advert|ad-|ads|adsbygoogle|promo|promotion|cookie|consent|paywall|newsletter|subscribe|social|share|sharing|follow|toolbar|pagination|pager|skip-link|sr-only|widget|toc-tree|searchbox|edit-this-page|prev-next|next-page)/i;

const HEADING = /^h([1-6])$/;
const PARAGRAPH_TAGS = new Set(["p", "li", "blockquote", "figcaption", "dt", "dd", "caption"]);
const CONTAINER_TAGS = new Set([
	"div",
	"section",
	"article",
	"main",
	"aside",
	"td",
	"th",
	"ul",
	"ol",
	"dl",
	"table",
	"tr",
	"thead",
	"tbody",
	"header",
	"footer",
	"nav",
	"figure",
	"details",
]);
const LANDMARK_TAGS = new Set(["article", "main"]);
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside"]);
const VOID_TAGS = new Set(["br", "img", "hr", "input", "meta", "link", "source", "area", "base", "col", "embed", "param", "track", "wbr"]);

export function stripDroppedTags(html: string): string {
	let out = String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ");
	for (const tag of DROPPED_TAGS) {
		out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
		out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
	}
	return out;
}

export interface HtmlBlock {
	type: "heading" | "para";
	level: number;
	text: string;
	/** True when the block sits inside `<article>` or `<main>`. */
	landmark: boolean;
}

interface StackFrame {
	name: string;
	skip: boolean;
	landmark: boolean;
	anchor: boolean;
}

/**
 * One pass over tags and text, with an explicit stack. Returns headings and paragraphs in document
 * order, each marked as chrome-free and as inside/outside a landmark.
 *
 * Two heuristics keep navigation out of the prose: a class or id that names chrome skips the whole
 * subtree, and a paragraph that is mostly link text and short is dropped (link farms, related-post
 * lists, footers).
 */
export function tokenizeBlocks(html: string): HtmlBlock[] {
	const blocks: HtmlBlock[] = [];
	const stack: StackFrame[] = [];
	let skipDepth = 0;
	let landmarkDepth = 0;
	let anchorDepth = 0;
	let headingLevel = 0;
	let headingText: string[] = [];
	let paraParts: string[] = [];
	let paraLinkChars = 0;
	let inPara = false;
	let paragraphLandmark = false;

	const skipping = (): boolean => skipDepth > 0;

	function flushHeading(): void {
		const text = normalizeText(headingText.join(" ")).slice(0, 200);
		const level = headingLevel;
		const landmark = landmarkDepth > 0;
		headingLevel = 0;
		headingText = [];
		if (text && level) blocks.push({ type: "heading", level, text, landmark });
	}

	function flushPara(): void {
		const text = normalizeText(paraParts.join(" "));
		const linkChars = paraLinkChars;
		const landmark = paragraphLandmark || landmarkDepth > 0;
		paraParts = [];
		paraLinkChars = 0;
		inPara = false;
		paragraphLandmark = false;
		if (text.length < 3) return;
		// A short block that is mostly links is navigation, not prose.
		if (text.length < 400 && linkChars / text.length > 0.5) return;
		if (/^\[\[code \d+\]\]$/.test(text)) {
			blocks.push({ type: "para", level: 0, text, landmark });
			return;
		}
		blocks.push({ type: "para", level: 0, text, landmark });
	}

	// Text, or a tag. The attribute group tolerates quoted `>` inside an attribute value.
	const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
	let match: RegExpExecArray | null;
	while ((match = tokenRe.exec(html)) !== null) {
		const textNode = match[4];
		if (textNode !== undefined) {
			if (skipping() || !textNode.trim()) continue;
			if (headingLevel) {
				headingText.push(textNode);
				continue;
			}
			if (!inPara) {
				inPara = true;
				paragraphLandmark = landmarkDepth > 0;
			}
			paraParts.push(textNode);
			if (anchorDepth > 0) paraLinkChars += textNode.replace(/\s+/g, " ").trim().length;
			continue;
		}

		const closing = match[1] === "/";
		const name = match[2].toLowerCase();
		const attrs = match[3] ?? "";

		if (VOID_TAGS.has(name)) {
			if (name === "br" && !closing && !skipping()) {
				if (headingLevel) headingText.push(" ");
				else paraParts.push("\n");
			}
			continue;
		}

		if (closing) {
			// Pop to the matching open tag, tolerating unclosed elements in between.
			let index = -1;
			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i].name === name) {
					index = i;
					break;
				}
			}
			if (index === -1) continue;
			for (let i = stack.length - 1; i >= index; i--) {
				const frame = stack[i];
				if (frame.skip) skipDepth--;
				if (frame.landmark) landmarkDepth--;
				if (frame.anchor) anchorDepth--;
			}
			stack.length = index;
			if (skipping()) continue;
			if (HEADING.test(name) && headingLevel) flushHeading();
			else if (PARAGRAPH_TAGS.has(name) || CONTAINER_TAGS.has(name)) flushPara();
			continue;
		}

		const chromeAttr = /(?:class|id)\s*=\s*("[^"]*"|'[^']*')/i.exec(attrs)?.[1]?.replace(/["']/g, "") ?? "";
		const frame: StackFrame = {
			name,
			skip: CHROME_TAGS.has(name) || CHROME_PATTERN.test(chromeAttr),
			landmark: LANDMARK_TAGS.has(name),
			anchor: name === "a",
		};
		stack.push(frame);
		if (frame.skip) skipDepth++;
		if (frame.landmark) landmarkDepth++;
		if (frame.anchor) anchorDepth++;
		if (skipping()) continue;

		if (HEADING.test(name)) {
			flushPara();
			flushHeading();
			headingLevel = Number(HEADING.exec(name)?.[1] ?? 1);
			headingText = [];
		} else if (PARAGRAPH_TAGS.has(name)) {
			flushPara();
			inPara = true;
			paragraphLandmark = landmarkDepth > 0;
		} else if (CONTAINER_TAGS.has(name)) {
			flushPara();
		}
	}
	flushHeading();
	flushPara();
	return blocks;
}

function attr(tag: string, name: string): string | undefined {
	const found = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
	if (!found) return undefined;
	const value = (found[2] ?? found[3] ?? found[4] ?? "").trim();
	return value ? decodeEntities(value) : undefined;
}

function metaContent(html: string, selectors: string[]): string | undefined {
	for (const selector of selectors) {
		const patterns = [
			new RegExp(`<meta[^>]*(?:name|property)\\s*=\\s*["']${selector}["'][^>]*>`, "i"),
			new RegExp(`<meta[^>]*content\\s*=\\s*["'][^"']*["'][^>]*(?:name|property)\\s*=\\s*["']${selector}["'][^>]*>`, "i"),
		];
		for (const pattern of patterns) {
			const tag = pattern.exec(html)?.[0];
			if (tag) {
				const content = attr(tag, "content");
				if (content) return content;
			}
		}
	}
	return undefined;
}

function resolveUrl(src: string, baseUrl: string): string | undefined {
	try {
		const resolved = new URL(src, baseUrl);
		if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined;
		return resolved.toString();
	} catch {
		return undefined;
	}
}

const IGNORED_IMAGE = /(logo|icon|favicon|avatar|sprite|badge|button|arrow|spinner|placeholder|tracking|pixel|analytics|\/1x1|blank\.(gif|png))/i;

interface Extracted {
	title?: string;
	author?: string;
	publishedAt?: string;
	language?: string;
	sections: WebSection[];
	images: WebImage[];
	codeBlocks: WebCodeBlock[];
	charCount: number;
	warnings: string[];
}

/**
 * HTML -> structured document. Pure, so it is the part covered by offline tests.
 *
 * Paragraph ordinals are what a `paragraph` locator points at: inside a section, `text` is
 * paragraphs joined by a blank line, so paragraph N is `text.split("\n\n")[N]`.
 */
export function extractDocument(html: string, baseUrl: string): Extracted {
	const warnings: string[] = [];
	const source = String(html ?? "");

	const title =
		normalizeText(
			metaContent(source, ["og:title", "twitter:title", "title"]) ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] ?? "",
		).slice(0, 300) || undefined;
	const author = metaContent(source, ["author", "article:author", "og:article:author", "twitter:creator"])?.slice(0, 200) || undefined;
	const publishedAt =
		metaContent(source, ["article:published_time", "og:article:published_time", "date", "publish-date", "parsely-pub-date"])?.slice(0, 60) ||
		/<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i.exec(source)?.[1] ||
		undefined;
	const language =
		(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(source)?.[1] ?? metaContent(source, ["og:locale", "language"]))?.slice(0, 20) ||
		undefined;

	// Code blocks come out first and leave a numbered marker behind, so the prose keeps a pointer
	// to the code without duplicating it (and without the code being mangled by text cleanup).
	const codeBlocks: WebCodeBlock[] = [];
	let working = source.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (_match, _attrs: string, inner: string) => {
		const codeTag = /<code\b([^>]*)>/i.exec(inner);
		const languageHint =
			attr(codeTag?.[0] ?? "", "class")
				?.split(/\s+/)
				.find((token) => /^(language|lang|brush)-/i.test(token))
				?.split("-")
				.slice(1)
				.join("-") || undefined;
		const code = normalizeText(
			inner
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/<\/(p|div|li)>/gi, "\n")
				.replace(/<[^>]+>/g, ""),
		);
		if (!code) return " ";
		codeBlocks.push({ ...(languageHint ? { language: languageHint } : {}), code: code.slice(0, 20_000), index: codeBlocks.length });
		return `\n<p>[[code ${codeBlocks.length - 1}]]</p>\n`;
	});

	// Figures: keep the caption with the image, because a caption is often the only description.
	const images: WebImage[] = [];
	const figureCaptions = new Map<string, string>();
	working = working.replace(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi, (_match, inner: string) => {
		const caption = normalizeText((/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(inner)?.[1] ?? "").replace(/<[^>]+>/g, "")).slice(0, 300);
		const imgTag = /<img\b[^>]*>/i.exec(inner)?.[0];
		const src = imgTag ? (attr(imgTag, "src") ?? attr(imgTag, "data-src")) : undefined;
		if (src && caption) figureCaptions.set(src, caption);
		return inner;
	});

	for (const imgMatch of working.matchAll(/<img\b[^>]*>/gi)) {
		const tag = imgMatch[0];
		const src = attr(tag, "src") ?? attr(tag, "data-src") ?? attr(tag, "data-lazy-src");
		if (!src || src.startsWith("data:")) continue;
		const resolved = resolveUrl(src, baseUrl);
		if (!resolved) continue;
		if (IGNORED_IMAGE.test(resolved) || IGNORED_IMAGE.test(attr(tag, "class") ?? "")) continue;
		const alt = normalizeText(attr(tag, "alt") ?? "").slice(0, 300) || undefined;
		const caption = figureCaptions.get(src)?.slice(0, 300) || undefined;
		const width = Number(attr(tag, "width") ?? 0) || undefined;
		const height = Number(attr(tag, "height") ?? 0) || undefined;
		// A 1x1 or a tiny declared size is decoration, not evidence.
		if ((width && width < 48) || (height && height < 48)) continue;
		if (images.some((image) => image.src === resolved)) continue;
		images.push({
			src: resolved,
			...(alt ? { alt } : {}),
			...(caption ? { caption } : {}),
			...(width ? { width } : {}),
			...(height ? { height } : {}),
		});
		if (images.length >= 40) break;
	}

	working = stripDroppedTags(working);
	const bodyMatch = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(working);
	const tokenized = tokenizeBlocks(bodyMatch ? bodyMatch[1] : working);

	// Landmark content wins when the page has any: everything outside <article>/<main> is furniture.
	const hasLandmark = tokenized.some((block) => block.landmark);
	const blocks = hasLandmark ? tokenized.filter((block) => block.landmark) : tokenized;
	if (!hasLandmark) warnings.push("no <article> or <main> landmark: extraction is heuristic and may include page furniture");

	const sections: WebSection[] = [];
	let current: WebSection = { heading: title ?? "Document", level: 1, text: "", index: 0 };
	for (const block of blocks) {
		if (block.type === "heading") {
			if (current.text.trim()) sections.push(current);
			current = { heading: block.text, level: block.level, text: "", index: sections.length + 1 };
			continue;
		}
		current.text = current.text ? `${current.text}\n\n${block.text}` : block.text;
	}
	if (current.text.trim()) sections.push(current);

	const kept = sections
		.map((section) => ({ ...section, text: section.text.replace(/\n{3,}/g, "\n\n").trim() }))
		.filter((section) => section.text.length > 0);
	if (kept.length < sections.length) warnings.push(`${sections.length - kept.length} near-empty section(s) dropped`);

	const charCount = kept.reduce((total, section) => total + section.text.length, 0);
	if (charCount < 200) {
		warnings.push(`only ${charCount} characters of text extracted: the page is probably rendered by JavaScript, blocked, or not an article`);
	}
	if (!kept.length) warnings.push("no readable sections found");

	// Attach each code block to the section that carries its marker, and each caption to its section.
	const sectionsOut = kept.map((section, index) => ({ ...section, index }));
	for (const block of codeBlocks) {
		const marker = `[[code ${block.index}]]`;
		block.section = sectionsOut.find((section) => section.text.includes(marker))?.heading ?? sectionsOut[0]?.heading;
	}
	for (const image of images) {
		const needle = (image.caption ?? image.alt ?? "").toLowerCase().slice(0, 40);
		image.section = needle
			? (sectionsOut.find((section) => section.text.toLowerCase().includes(needle))?.heading ?? sectionsOut[0]?.heading)
			: sectionsOut[0]?.heading;
	}

	return {
		...(title ? { title } : {}),
		...(author ? { author } : {}),
		...(publishedAt ? { publishedAt } : {}),
		...(language ? { language } : {}),
		sections: sectionsOut,
		images,
		codeBlocks,
		charCount,
		warnings,
	};
}

export interface FetchLimits {
	maxBytes: number;
	timeoutMs: number;
}

/**
 * Fetch exactly one document. Refuses non-http(s) targets, caps the body, honours the caller's
 * abort signal, and reports a non-HTML content type instead of trying to parse it.
 */
export async function fetchDocument(
	target: string,
	limits: FetchLimits,
	signal?: AbortSignal,
): Promise<{ doc?: WebDocument; error?: string }> {
	const classified = classifyTarget(target);
	if (classified.error) return { error: classified.error };
	if (classified.kind !== "web") return { error: `${classified.kind} targets are not handled by the web adapter` };

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("timeout")), limits.timeoutMs);
	const onOuterAbort = (): void => controller.abort();
	signal?.addEventListener("abort", onOuterAbort, { once: true });

	try {
		const response = await fetch(classified.canonical, {
			signal: controller.signal,
			redirect: "follow",
			headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
		});
		if (!response.ok) return { error: `HTTP ${response.status} ${response.statusText} for ${classified.canonical}` };

		const contentType = response.headers.get("content-type") ?? "";
		if (!/text\/html|application\/xhtml\+xml|text\/plain|application\/json|text\/markdown/i.test(contentType)) {
			return { error: `unsupported content type "${contentType}" — this adapter reads HTML documents` };
		}

		// Stream with a cap: a 2 GB page must not be buffered to discover it is too big.
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		if (response.body) {
			const reader = response.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					bytes += value.byteLength;
					if (bytes > limits.maxBytes) {
						await reader.cancel().catch(() => undefined);
						return { error: `document exceeds the ${limits.maxBytes} byte limit` };
					}
					chunks.push(value);
				}
			}
		} else {
			const text = await response.text();
			bytes = Buffer.byteLength(text, "utf8");
			if (bytes > limits.maxBytes) return { error: `document exceeds the ${limits.maxBytes} byte limit` };
			chunks.push(new TextEncoder().encode(text));
		}

		const html = Buffer.concat(chunks).toString("utf8");
		const extracted = extractDocument(html, response.url || classified.canonical);
		return {
			doc: {
				url: classified.canonical,
				finalUrl: response.url || classified.canonical,
				status: response.status,
				...(extracted.title ? { title: extracted.title } : {}),
				...(extracted.author ? { author: extracted.author } : {}),
				...(extracted.publishedAt ? { publishedAt: extracted.publishedAt } : {}),
				...(extracted.language ? { language: extracted.language } : {}),
				sections: extracted.sections,
				images: extracted.images,
				codeBlocks: extracted.codeBlocks,
				htmlBytes: bytes,
				charCount: extracted.charCount,
				warnings: extracted.warnings,
			},
		};
	} catch (error) {
		const message = (error as Error)?.message ?? String(error);
		if (/abort/i.test(message)) {
			return { error: signal?.aborted ? "fetch cancelled" : `fetch timed out after ${limits.timeoutMs}ms` };
		}
		return { error: `fetch failed: ${message}` };
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onOuterAbort);
	}
}

/**
 * Download the document images worth keeping as evidence (figures with a caption or alt text).
 * Skips silently on any failure: a missing figure is a coverage gap, not a failed ingestion.
 */
export async function fetchImages(
	images: WebImage[],
	baseUrl: string,
	options: { maxImages: number; maxBytes: number; timeoutMs: number; signal?: AbortSignal },
): Promise<{ file: string; url: string; bytes: number; caption?: string; section?: string; data?: string; error?: string }[]> {
	const out: { file: string; url: string; bytes: number; caption?: string; section?: string; data?: string; error?: string }[] = [];
	const wanted = images.filter((image) => image.caption || image.alt).slice(0, options.maxImages);
	let index = 0;
	for (const image of wanted) {
		index += 1;
		const resolved = resolveUrl(image.src, baseUrl);
		if (!resolved) continue;
		const extension = /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.exec(resolved)?.[1]?.toLowerCase().replace("jpeg", "jpg") ?? "jpg";
		const file = `doc-${String(index).padStart(3, "0")}.${extension}`;
		try {
			const response = await fetch(resolved, { signal: options.signal, headers: { "user-agent": USER_AGENT } });
			if (!response.ok) {
				out.push({ file, url: resolved, bytes: 0, error: `HTTP ${response.status}` });
				continue;
			}
			const buffer = Buffer.from(await response.arrayBuffer());
			if (buffer.byteLength > options.maxBytes) {
				out.push({ file, url: resolved, bytes: buffer.byteLength, error: "above the image size limit" });
				continue;
			}
			out.push({
				file,
				url: resolved,
				bytes: buffer.byteLength,
				...(image.caption ? { caption: image.caption } : {}),
				...(image.section ? { section: image.section } : {}),
				data: buffer.toString("base64"),
			});
		} catch (error) {
			out.push({ file, url: resolved, bytes: 0, error: (error as Error).message });
		}
	}
	return out;
}
