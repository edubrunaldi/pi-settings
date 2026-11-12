# knowledge (Pi extension)

| | |
|---|---|
| Source in this repo | `extensions/knowledge/` (`index.ts`, `activation.ts`, `logic.ts`, `params.ts`, `store.ts`, `ingest.ts`, `jobs.ts`, `media.ts`, `web.ts`, `render.ts`, `types.ts`) |
| Installed at | `~/.pi/agent/extensions/knowledge/` (or loaded straight from the repo as a Pi package) |
| Command | `/knowledge` |
| Tools | `knowledge` (globally toggled; off by default) |
| Skill | `skills/knowledge/SKILL.md` — the operating procedure the model follows |
| Files it writes | library under `~/.pi/knowledge/` (records, evidence, jobs, index, config, ASR models); activation at `~/.pi/agent/knowledge/activation.json`; no session entries |
| Tests | `npm run check`, `node tests/load-check.mjs extensions/knowledge/index.ts` |

A persistent, source-grounded knowledge base. A video, article or local file
becomes evidence; the model distils the evidence into records; a later session
finds those records by search and applies them with whatever tools it has.

```text
learn (mechanical)                the model (distillation)              later session
target → stages → evidence.json → evidence pages (transcript, sections, → search / read → apply
                                   frames as images) → write records
```

## What it does, and the design split

- The **extension** does the mechanical work only: fetch, transcribe, extract
  frames, validate, store, retrieve. Deterministic, resumable, testable
  offline.
- The **model** does the distillation: it reads evidence pages
  (`action=evidence`, frames included as images) and writes records
  (`action=write`). There is **no nested model call** — no second bill, no
  hidden prompt, and the reasoning stays visible in the session that produced
  the record.

Trust rules that follow from the split:

- a record is never "true", it is *supported*: `validation` keeps three
  separate axes (source support, practical test, human review);
- every claim carries `evidence` with a locator into `_sources/<id>`, so an
  audit can re-read the original wording in its original language;
- `action=write` refuses a record with no locatable evidence, and refuses a
  citation to a source that was never ingested (fabricated provenance);
- source content reaches the model only through an "untrusted data" wrapper —
  a page can contain "ignore previous instructions", and that text stays inert.

## The `/knowledge` command

For a human at the terminal. Tab completion offers the subcommands; with no
subcommand it runs `status`.

| Command | What it does |
|---|---|
| `/knowledge on` | persist global activation; expose the tool, its rules and the skill in all sessions |
| `/knowledge off` | persist global deactivation; withdraw the tool and its rules, and hide the skill advertisement |
| `/knowledge` or `/knowledge status` | show global activation and preference path; when on, also show library counts and root |
| `/knowledge learn <target> [focus]` | hands the run to the agent: sends a user message telling it to load `/skill:knowledge`, call `action=learn`, read the evidence and write the durable records. `<target>` is an http(s) URL, `yt:<videoId>` or `file:<path>` |
| `/knowledge search <query>` | lexical search over all records, top 5, as a notification of `id (score)` pairs |
| `/knowledge jobs` | the 5 most recently updated jobs as `id: state/stage` |
| `/knowledge sources` | source count and up to 4 source ids |
| `/knowledge config` | one line: root, whisper model, `maxFrames` |
| `/knowledge path [record-id]` | the record's directory (a bare slug is accepted when exactly one record matches), or the root with no id; record ids are offered as argument completions |

Every subcommand only emits notifications; in a headless run the command
degrades to a no-op notification, and the tool itself never needs a terminal.
The command never ingests by itself: `learn` delegates to the agent because
distillation is the model's half of the work.

## The `knowledge` tool

One tool with an `action` discriminator (nine actions), so a session pays for
a single declaration. Invalid calls are refused with a message that names the
exact rule that was broken.

| Action | Parameters | What it does |
|---|---|---|
| `learn` | `target` (required), `focus`, `domain`, `topic`, `force` | Runs the ingestion pipeline for one source. Idempotent: the job id is a fingerprint of target + limits, so a finished job with its evidence is reused unless `force=true`, and an interrupted job resumes. Returns a bundle summary, the per-stage coverage report and the next steps |
| `evidence` | `source` (required), `transcriptFrom`, `transcriptChars`, `sections`, `frames` | Returns one page of what was extracted. Transcript: paged within `transcriptPageChars` (minimum 500), with `nextIndex`/`done` for exact resume. Sections: with paragraph ordinals (`[¶N]`) and locator hints. Frames: returned as image blocks, at most 8 per call, each file at most 4 MB, downscaled to `frameWidth` at extraction. Code blocks are capped at 8000 chars per call. A call that requests frames or sections returns no transcript page unless `transcriptFrom` or `transcriptChars` is explicit, in which case both come back together. All source text is wrapped as untrusted data |
| `write` | `record` (required) | Validates and persists one record (`knowledge.json` + generated `knowledge.md`), rebuilds the index, and marks contributing jobs `distilled`. Refusals: no evidence, a locator without position, an unknown `sourceId`, missing kind-required fields, overlong fields. Controlled-English findings are returned with the result but never block the write |
| `search` | `query` (required), `domain`, `kind`, `status`, `product`, `limit` | Lexical scoring with field weights (title 6, aliases 5, terms 4, summary 3, steps 2, failure signals 2, topic 2, domain 2, body 1; prefix matches half). An exact phrase in the title or an alias doubles the score and adds 4. Status penalties: contested ×0.8, draft ×0.7, superseded ×0.4 — penalised, never hidden. Default limit is `searchTopK` (8) |
| `read` | `id` (required) | The full record in a dense model-facing view (trust line, applies-to, steps, failure modes, evidence, coverage gaps) plus its file paths. Accepts a bare slug when exactly one record matches |
| `jobs` | `id` (optional) | One job with its per-stage coverage, or all jobs sorted by most recently updated |
| `cancel` | `id` (required) | Marks the job file `cancelled`. It does not kill a running process: a running ingestion is stopped by aborting the run (Esc). Finished stages are kept, so a retry resumes |
| `sources` | — | Lists every ingested source id with kind, state, title, transcript segment count and origin, frame count and section count |
| `config` | `config` (optional: `limits`, `domains`, `glossary`) | Without a patch: root, record/source/job counts and the full JSON config. With a patch: merges over the defaults, validates (unknown keys are refused by name, numbers must be positive) and persists to `_config.json`. `root` cannot be set through the tool — edit `_config.json` or set `PI_KNOWLEDGE_DIR` |

Record field limits enforced by `write` (refusals name the limit): `title` 80
chars, `summary` 600, `body` 8000, each `steps` entry 240, `expectedResult`
300, `coverageGaps` 600, evidence `quote` 280, locator `ref` 200, evidence
`note` 240, failure `signal` 200, at most 40 entries per list. Kind rules: a
`procedure` needs at least 1 step plus `expectedResult` or `verification`; a
`diagnostic` needs at least 1 `failureModes` entry with a signal; a
`constraint` needs at least 1 `appliesTo` entry; every record needs at least
1 evidence entry with a locator.

### Ingestion stages per source kind

Targets are classified first: a YouTube URL or `yt:<videoId>` goes to the
youtube adapter, any other http(s) URL to the web adapter, `file:<path>` or a
bare path to the file adapter. Any other scheme (`ftp://`, …) is refused —
only http and https are ever fetched.

| Kind | Stages, in order | Notes |
|---|---|---|
| `youtube` | meta → captions → audio → transcribe → frames → evidence | yt-dlp with `--js-runtimes node --remote-components ejs:github` on every command; captions from at most 2 explicit language tracks (manual first, then one automatic, then automatic English); local whisper ASR only when captions cover less than 70% of the duration; frames prefer a ≤360p video-only download |
| `web` | fetch → extract → evidence | one HTTP request, body capped at `maxHtmlBytes`, timeout the smaller of 120 s and `commandTimeoutSeconds`; heuristic HTML extraction (landmarks, chrome stripping, link-density filter) that records a warning whenever it had to guess; up to 8 figures with a caption or alt text, each ≤6 MB |
| `file` | probe → extract → transcribe → frames → evidence | text-like files (markdown, txt, html, json, csv, srt/vtt, yaml, source code) are read as documents up to `maxHtmlBytes`; audio and video need ffmpeg; a single image is kept as `frame_000` |

`evidence_ready` is not success: every stage records
done/partial/skipped/failed with a reason, and that coverage report is part of
what the model sees. A video with no captions and no ASR model produces a
bundle that says so instead of an empty record that looks complete. A
transcript covering less than 90% of the duration is flagged `partial`.

The frame download prefers a video-only stream at ≤360p: audio is unnecessary
and combined streams can be substantially larger. Fallbacks select a combined
stream at ≤360p, then the lowest-quality video-only or combined stream when
no capped format exists. Thus 360p is a preference, not a hard download cap.
The video command ignores user yt-dlp configuration so overrides cannot skip
the download or change its output location. Socket waits are capped at 20 s;
download and fragment retries are capped at 2, within `commandTimeoutSeconds`.
A zero exit code without a non-empty finalized video is a failed frame stage.
Diagnostics include termination, remaining `.part` files, and meaningful output
from both stdout and stderr. No partial download is treated as usable evidence.

Frame extraction samples uniformly first (frame N sits at
(N−1)×interval, interval = max(`sampleEverySeconds`, duration/`maxFrames`)),
then supplements with scene detection at `sceneThreshold`, skipping a cut that
lands within a quarter of the sampling interval of a frame already kept. The
default is 0.05 because a real talking-head video measured a maximum scene
score of 0.059 — the common 0.3 default would select nothing there; raise it
for fast-cut footage. Files are renamed `frame_000.jpg`, `frame_001.jpg`, … in
timeline order, so a citation is checkable, and a frame that cannot be moved
into `assets/` is dropped rather than listed under a name that does not exist.

## What it writes: `~/.pi/knowledge/`

```text
~/.pi/knowledge/
├── _config.json                # limits, domains, glossary — user configuration
├── _sources/<sourceId>/        # evidence.json + assets/ — canonical evidence
│   └── assets/                 # frame_NNN.jpg, doc-NNN.<ext>, kept media
├── _jobs/<jobId>.json          # resumable ingestion state, one file per job
├── _models/ggml-*.bin          # local whisper ASR models (re-downloadable)
├── _index/index.json           # manifest, rebuilt on every write
└── <domain>/<topic>/<slug>/
    ├── knowledge.json          # the record — canonical
    └── knowledge.md            # generated from the JSON, never hand-edited
```

Ids are deterministic: `sourceId` is `youtube-<videoId>`,
`web-<host>-<hash>` or `file-<name>-<hash>`; `jobId` is `job-` plus the first
12 chars of the target+limits fingerprint. Domain directories may never
collide with the store's furniture (`_sources`, `_jobs`, `_models`, `_index`,
`_glossary`, `_cache` are reserved; anything starting with `_` or `.` is
skipped when records are listed).

| Category | Contents |
|---|---|
| Canonical | `knowledge.json` per record, `evidence.json` per source, frames and document figures in `assets/`, `_config.json` |
| Generated | `knowledge.md` (rendered from the JSON, so the two cannot drift), `_index/index.json` (rebuilt on every write; deleting `_index/` costs a rescan, not knowledge) |
| Rebuildable / re-downloadable | `_models/*.bin` (fetched once from Hugging Face), downloaded audio/video (deleted by default — see `keepMedia`) |

All JSON writes are atomic (temp file + rename in the same directory), so an
interrupted run leaves either the old file or the new one, never a half-written
record. A corrupt file is skipped with its path reported; one bad record cannot
make the whole library unreadable.

Root resolution, in priority order:

1. `PI_KNOWLEDGE_DIR` environment variable — an operator override that always
   wins (tests, a second library);
2. `root` in `_config.json` at the derived location — lets a user relocate the
   library;
3. `~/.pi/knowledge`, derived from the agent directory so a rebranded Pi keeps
   its own layout.

## Configuration

Defaults (`DEFAULT_LIMITS` in `logic.ts`). Change them with
`knowledge action=config config={"limits":{…},"domains":[…]}` (merged and
persisted to `_config.json`) or by editing `_config.json` directly — the only
way to set `root`. Unknown keys are refused by name; numbers
must be positive. A broken config file falls back to defaults and surfaces the
error instead of silently applying them.

| Key | Default | What it controls |
|---|---|---|
| `maxDurationSeconds` | `10800` (3 h) | refuse audio/video longer than this |
| `maxHtmlBytes` | `20971520` (20 MB) | cap on a fetched HTML body and on a local text-like file |
| `maxFrames` | `48` | cap on frames extracted per video |
| `frameWidth` | `640` | frames are scaled down to this width |
| `sceneThreshold` | `0.05` | scene-change score threshold; raise it for fast-cut footage (see frame extraction above) |
| `sampleEverySeconds` | `30` | preferred uniform frame interval; widened for long sources to stay under `maxFrames` |
| `whisperModel` | `ggml-base.bin` | ASR model: a bare `ggml-*.bin` file name (downloaded into `_models/`), or a path to a model you already have (no download) |
| `whisperLanguage` | `auto` | language hint for caption selection and ASR |
| `whisperTranslate` | `false` | translate ASR output to English |
| `keepMedia` | `none` | retention after extraction: `none` deletes downloaded audio and video, `audio` keeps the audio, `all` keeps everything. Frames and `evidence.json` are never deleted |
| `transcriptPageChars` | `12000` | characters of transcript per evidence page (minimum 500) |
| `searchTopK` | `8` | default cap on search results |
| `commandTimeoutSeconds` | `900` | timeout per external command (the web fetch uses the smaller of 120 s and this value) |

Two more config keys:

- `domains` — open list, offered first when the model must choose a domain.
  Default: `animation`, `programming`, `tooling`, `design`, `operations`,
  `science`, `business`, `health`, `music`, `general`.
- `glossary` — preferred terms per domain, shaped
  `{ "<domain>": { "<preferred>": ["alias", …] } }`. `action=write` checks new
  records against the glossary of their domain and flags alias usage
  (advisory).

## External dependencies

The extension itself has none (host packages are peer dependencies), but
ingestion shells out. Every binary is optional per stage: when one is missing,
the stage records a coverage entry naming the fix, never a stack trace and
never a silent empty bundle.

| Binary | Needed for | Check |
|---|---|---|
| python + `yt-dlp` | everything YouTube (metadata, captions, audio, video) | `python -m yt_dlp --version` |
| `ffmpeg` built with the whisper filter | local ASR, frame extraction, media probing | `ffmpeg -hide_banner -filters \| grep whisper` |
| `curl` | the one-time ASR model download | `curl --version` |
| Node.js on PATH | yt-dlp's YouTube JS runtime (the extension passes `--js-runtimes node --remote-components ejs:github` on every YouTube command; current yt-dlp refuses YouTube without it) | `node --version` |

The pipeline prefers `python -m yt_dlp` over the `yt-dlp` console shim: a
user-level pip install frequently leaves the shim (on Windows,
`%APPDATA%\Python\...\Scripts`) off PATH, while the module form works whenever
the package is installed. The shim is the fallback.

Windows (PowerShell):

```powershell
python -m pip install --user yt-dlp
winget install Gyan.FFmpeg        # or any recent build; then check the whisper filter
ffmpeg -hide_banner -filters | Select-String whisper
```

Linux / macOS:

```bash
python3 -m pip install --user yt-dlp   # or: pipx install yt-dlp
sudo apt install ffmpeg                # macOS: brew install ffmpeg
ffmpeg -hide_banner -filters | grep whisper
```

If the whisper filter check prints nothing, that ffmpeg build predates the
whisper.cpp filter (verified working here: ffmpeg 9.0.2). Captions still work
without it; local ASR and frame extraction are skipped with a coverage note
that says so.

The whisper ggml model is downloaded on first ASR use with curl into
`_models/`, from
`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<whisperModel>`.
The default `ggml-base.bin` is about 148 MB. Set `whisperModel` to a path
instead of a file name to use a model you already have and skip the download
entirely.

The download is guarded, because a slow CDN once made a run look hung for
minutes: curl gets `--connect-timeout 20`, `--max-time 900`, and
`--speed-limit 2048 --speed-time 20` (abort after 20 s below 2 KB/s), plus
`-C -` so a retry resumes the `.part` file instead of restarting. A file that
arrives shorter than 90% of its known size is reported as a stalled transfer
and never loaded as a model. The stage announces the download and its size
before it starts, so a long wait is visible progress rather than silence.

Known models:

| File | Size | Notes |
|---|---|---|
| `ggml-tiny.bin` | ~78 MB | fastest, weakest; fine for a smoke test |
| `ggml-base.bin` | ~148 MB | multilingual, the default |
| `ggml-base.en.bin` | ~148 MB | English only, slightly better on English |
| `ggml-small.bin` | ~488 MB | multilingual, noticeably better, slower |
| `ggml-medium.bin` | ~1.5 GB | large download; only for hard audio |

## Privacy

Stored on disk (all under the knowledge root): the full transcript text,
article sections and code blocks in `evidence.json`; extracted frames and
document figures; every record as JSON and Markdown; job files (which contain
the target URLs/paths); the config; the ASR model. Downloaded audio or video
only when `keepMedia` is `audio` or `all` — with the default `none` they are
deleted right after extraction.

Leaves the machine, and only during `learn`:

- the fetch itself — one HTTP request per source (user agent
  `Pi-Knowledge/1.0`), plus up to 8 document images ≤6 MB each;
- YouTube traffic through yt-dlp (metadata, captions, audio, a video preferring ≤360p);
- the one-time model download from `huggingface.co`.

`search`, `read`, `evidence`, `write`, `jobs`, `cancel`, `sources` and
`config` are purely local. The web adapter is not a crawler: one URL the user
pointed at, one request, no link following. To delete data, remove the
`_sources/<id>` directory, a record directory, or the whole root.

## Limitations

- **No PDF.** The file adapter reads text-like files, subtitles, audio, video
  and images; the web adapter refuses non-HTML content types.
- **Lexical search only.** No embeddings: scoring is token matching with
  field weights, so synonyms outside `aliases`/`terms` are missed.
- **No background daemon.** Jobs are resumable, but an interrupted run
  (Esc, session end) continues only when `learn` is invoked again with the
  same target and limits. A resume reuses every artifact a finished stage left
  behind — metadata, captions, the ASR transcript and the frames — so only the
  stages that never completed are redone. `force=true` wipes the source
  directory first and starts clean.
- **Captions are not guaranteed**, and YouTube answers aggressive caption
  requests with HTTP 429. The pipeline requests at most 2 explicit language
  tracks (never a regex like `en.*`, which matches translated tracks and
  triggers dozens of requests), but the risk is not zero.
- **ASR quality depends on the model** — the default `ggml-base.bin` is a
  middle ground; a partial or noisy transcript is flagged in coverage.
- **JavaScript-rendered pages yield little text.** The extractor says so
  ("only N characters of text extracted…") instead of presenting a stub as a
  learned article; extraction is heuristic (no DOM parser) and records a
  warning whenever it guessed.
- **Frames are a sample**, not every frame: uniform interval plus scene cuts,
  capped at `maxFrames` (48).
- **Retention deletes downloaded media by default** (`keepMedia: none`);
  frames and `evidence.json` always stay, because they are what makes a
  citation checkable.
- **`action=cancel` only marks the job file.** Stopping the actual processes
  means aborting the run (Esc).
- **The `config` tool patch accepts `limits`, `domains` and `glossary`**;
  `root` needs a direct `_config.json` edit or `PI_KNOWLEDGE_DIR`.
- **Videos longer than 3 h are refused** by default (`maxDurationSeconds`).
- Frame assets over 4 MB are not served to the model; code blocks over 8000
  chars per evidence page are truncated with a note.

## Global activation

Knowledge starts **off** unless a saved preference says otherwise. Only the
human commands `/knowledge on` and `/knowledge off` change that preference;
the model-facing tool cannot enable itself. The last successful write wins
across projects, restarts, new sessions, resumed sessions and forks.

The preference lives at `getAgentDir()/knowledge/activation.json` (normally
`~/.pi/agent/knowledge/activation.json`), independent of `PI_KNOWLEDGE_DIR` and
the library configuration. Writes use a unique temporary file and atomic
rename. Missing, malformed, unsupported or unreadable state fails closed to
off; `/knowledge status` reports read errors. A failed save is reported as an
error, not as a successful toggle. Disabling never deletes library data.

Off re-registers the tool with `exposure: "hidden"`, removing it from model
declarations, prompt rules, nested execution and codemode discovery. The
skill is authored with `disable-model-invocation: true` so even the initial
startup prompt does not advertise it. The extension enables its advertisement
in structured prompt options only for runs where knowledge is on. Explicit
`/skill:knowledge` and `/knowledge learn` are blocked while off. Local human
inspection commands (`search`, `jobs`, `sources`, `config`, `path`) still work
without exposing the library to the model.

Each started session watches the same preference file with a 250 ms stat
interval, including creation and atomic replacement. Commands, run/turn
boundaries and tool execution also reread it, so they do not rely solely on
watcher timing. Tool visibility refreshes dynamically; skill advertisement
changes at the next agent run. No process, socket or timer starts in the
factory. `session_shutdown` disposes the watcher and drops the cached store.

This is an availability switch, **not a filesystem security boundary**. It
does not erase previously loaded instructions, tool results or history, recall
an already-sent model request, or cancel ingestion already in progress. A
model with filesystem access can still read known library paths if explicitly
instructed. All open runtimes must load this implementation once with
`/reload` or restart; after that, on/off changes need no reload.

## Test

Offline:

```bash
npm run check                                        # behavior tests + Pi's real loader, all extensions
node tests/run.mjs                                   # knowledge cases: logic, jobs, media, web, store and an ingest walk with a fake exec — no network, no real binaries
node tests/load-check.mjs extensions/knowledge/index.ts
# expect: errors: none · tools: knowledge · commands: knowledge
# handlers: session_start, before_agent_start, turn_start, input, session_shutdown
```

Manual activation check (no external binaries needed):

1. Reload two sessions once to load this implementation. With no preference,
   `/knowledge status` shows off; the tool and skill are not advertised.
2. Run `/knowledge on` in one session. Check tool discovery in the other and
   start a new agent run there to check the skill advertisement. Start another
   session and confirm it also restores on.
3. Run `/knowledge off`. Check the tool disappears from direct declarations
   and codemode discovery in the other session. Its next agent run must not
   advertise the skill. Restart or resume a session and confirm it stays off.
4. While off, `/knowledge learn <target>` and `/skill:knowledge` must warn
   without launching a model request. Existing records must remain intact.

Offline activation tests exercise atomic persistence, two live observers,
startup and boundary reconciliation, invalid state, failed writes, stale
execution handles, skill visibility and watcher disposal.

Manual end-to-end (run `/knowledge on` first; needs the external binaries above):

Measured on this machine (Windows, ffmpeg 9.0.2 with the whisper filter,
yt-dlp 2026.10.26, node 24, `ggml-base.en.bin` reused from disk): a 466 KB
static documentation page ingested in **1.4 s** (7 sections, 2 figures); a
241 s Creative Commons video with no caption tracks ingested in **46 s**
(metadata 4 s, audio 3.9 s, local ASR 32 s, ≤360p video 4.4 s, 9 frames
0.6 s), with the downloaded containers removed afterwards and 34–36 KB frames
returned to the model as image blocks. Two records distilled from that
evidence were then found by `search` from a **fresh process**, with their trust
flags, citations and coverage gaps intact, and both jobs moved to `distilled`.
A first ASR run additionally pays the one-time model download (~148 MB).

1. **Article.** `/knowledge learn https://example.com/some-article` (or ask
   the model to call `knowledge action=learn target=…`). Check the coverage
   report, read `action=evidence source=… sections=[0,1]`, write one record,
   then `/knowledge path <record-id>` and open `knowledge.json` /
   `knowledge.md`.
2. **Short YouTube video.** `/knowledge learn yt:<videoId>`. Check the
   transcript origin (`captions`, `auto_captions` or `asr`), page it to
   `done=true`, look at frames (`frames=[0,1,2,…]`, batches of 8), write a
   record that cites both a time span and a frame.
3. **Retrieval from a new session.** Restart Pi (or open a fresh session) and
   ask something the records cover. The model should call
   `knowledge action=search` first, `action=read` the record, and report its
   trust flags (`untested`, `unreviewed`, `contested`) instead of reciting it.
4. **Config.** `/knowledge config` and `knowledge action=config` (no patch)
   should agree; set `limits.keepMedia="audio"`, re-learn with `force=true`,
   and check the audio file survives in `_sources/<id>/`.
