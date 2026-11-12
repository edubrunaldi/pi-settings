# new-session (Pi extension)

| | |
|---|---|
| Source in this repo | `extensions/new-session/` (`index.ts`, `logic.ts`) |
| Installed at | `~/.pi/agent/extensions/new-session/` (or loaded straight from the repo as a Pi package) |
| Command | `/new-session [--model <pattern>] [--effort <level>] [text]` |
| Tools | none — this is a human decision, so no model-facing tool is registered |
| Files it writes | `~/.pi/agent/new-session/recent-models.json` (models this flow started, newest first) |
| Tests | `node tests/run.mjs`, `node tests/load-check.mjs extensions/new-session/index.ts` |

`/new` starts a new session on whatever model your settings default to, and then
you type. This command starts a new session on the model and thinking level you
choose, with the first input already sent:

```text
model → effort → input source → review → new session, prompt running
```

The current session is **replaced** the way `/new` replaces it: it stays on disk,
is recorded as the parent of the new one, and comes back with `/resume`.

## Usage

```text
/new-session                                   ask for everything
/new-session refactor the auth middleware      that text is the first input
/new-session --model opus:high start over      named model, level from the pattern
/new-session --model sonnet --effort low go    explicit level, no effort dialog
```

| Flag | Meaning |
|---|---|
| `--model <pattern>` | `provider/id`, a bare id, a word from the display name, or any of those with a `:level` suffix. Skips the model picker when it resolves |
| `--effort <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Skips the effort picker when the model supports it |
| remaining text | the first input of the new session. Skips the input step once |

Everything else is asked with the standard Pi dialogs. `Enter` accepts the row
marked with `*`, `Esc` closes the flow and leaves this session untouched.

### The model step

A shortlist is shown first: this session's model (marked, so `Enter` means "same
model"), then the models this flow started recently, then the session's scoped
models (`--models`, `enabledModels`), then the configured default, then other
credentialed models up to 12 rows. The last row is
`Search all models by provider/id or name`, which opens a text input.

A typed pattern is resolved with the same preference Pi uses for `--model`:
exact `provider/id`, then exact bare id, then a substring of `provider/id` or of
the display name; between providers offering the same id, the one with
credentials wins. A trailing `:level` is read only when the whole text matches
nothing, so an OpenRouter id like `qwen/qwen3-coder:exacto` still resolves.

Nothing is guessed: an unknown pattern, an ambiguous one (the candidates are
listed) or a model without credentials (the message names `/login <provider>`)
sends the flow back to the picker with the reason on screen.

### The effort step

The picker offers the levels that model actually supports —
`getSupportedThinkingLevels(model)`, so a non-reasoning model gets no dialog at
all. The marked row is chosen in this order: the level saved for that model with
`Ctrl+S` in `/model`, this session's level when the model has it, otherwise
`medium`, otherwise the first supported one. A level you asked for that the model
lacks is clamped the way Pi clamps it (nearest level at or above, then below) and
the review screen says so instead of hiding it.

### The input step

| Source | What the new session receives |
|---|---|
| Last assistant message, as it is | the newest assistant text from this branch, verbatim |
| Handoff prompt built from the last assistant message | one model call that rewrites that message as a self-contained prompt for a fresh session |
| Type it myself | whatever you write |

The handoff is what makes "the model writes the plan here, the next session
executes it" one keystroke: it reads the last assistant message plus the recent
turns (and any compaction summary) under a character budget, and answers with the
prompt only. Its system prompt refuses to invent file paths, ids or tasks. Costs
one request, is cancellable with `Esc`, and its result always goes through the
editor before it is sent — so you can fix one line of it.

Whatever path you take, the text ends up in the multi-line editor and the edited
version is what gets sent. An empty input is refused, not sent.

### The review

A confirmation block, then the choice to change one thing without losing the
rest:

```text
model    anthropic/claude-opus-4-1
effort   high (xhigh is not supported by this model)
input    Handoff prompt built from the last assistant message — 412 chars
cwd      /repo/path

<first 300 chars of the prompt>

The current session is saved and stays resumable with /resume.
```

`No` opens `model / effort / input / discard`. Changing the model re-runs the
effort step, because the levels belong to the model.

## How the model and level reach the new session

This is the non-obvious part, and the reason the extension is not a ten-line
command.

Pi has no per-new-session model API:

- `ctx.newSession({ setup, withSession })` creates the session, then
  `createAgentSession()` resolves its model from `defaultProvider` /
  `defaultModel` in settings. `setup` can only append session entries, and
  appending a `model_change` does not touch the live `agent.state.model`;
- `pi.setModel()` and `pi.setThinkingLevel()` act on the **current** session, and
  the `pi` handle of the session being replaced is stale after the switch — using
  it throws;
- `ReplacedSessionContext` (the `ctx` handed to `withSession`) is a command
  context plus `sendUserMessage`, and neither exposes a model setter.

So the choice travels in a hand-off mailbox:

```text
command (old instance)  → mailbox.current = {provider, modelId, effort, previousSessionFile, createdAt}
                      → ctx.newSession({parentSession, withSession})
new instance session_start → takeHandoff() → pi.setModel() → pi.setThinkingLevel()
withSession                → ctx.sendUserMessage(prompt)
```

`session_start` of the replacement session is emitted by
`InteractiveMode.rebindCurrentSession()` **before** `AgentSessionRuntime.finishSessionReplacement()`
invokes `withSession()`, which is exactly the ordering needed: the input goes out
on the chosen model. Two consequences the code depends on:

- the mailbox lives on `globalThis` under `Symbol.for("pi-settings.new-session.handoff")`.
  Pi's loader imports extensions with `moduleCache: false`, so the module is
  re-evaluated for the replacement session and module-level state would be gone;
- only plain data crosses it. The consumer matches `reason: "new"` **and** the
  `previousSessionFile` the hand-off names, expires anything older than 20 s, and
  clears the entry when it consumes it — including when it cannot apply it. A
  switch cancelled by another extension clears the entry from the writing side, so
  a refused hand-off can never colour a later, unrelated `/new`.

`pi.setModel()` also records a `model_change` on the new branch, so `/resume`
restores the same model and level for that session.

## Limitations and deliberate omissions

- **Interactive only.** `print`, `json` and `rpc` hosts get a notification, not a
  dialog that would hang.
- **Same working directory.** `newSession()` always creates the session in the
  current cwd. There is no `--dir`, because Pi's runtime would need a different
  service set for it.
- **No conversation transfer.** The new session starts empty; the only context it
  can get is the prompt you send (that is what the handoff source is for). This is
  not `/handoff`: nothing is summarized into a draft for you to review before the
  session exists.
- **No session name.** The new session is unnamed; `/name` sets it there.
- **No model-facing tool.** By design — the flow replaces the session you are
  talking in, so a model should not be able to pull that rug. If a tool is ever
  wanted, a tool cannot call `newSession()`: it would have to record the request
  and let `agent_settled` dispatch `/new-session` with `expandPromptTemplates`.
- The recent list is per machine and never pruned by age; it is capped at
  `RECENT_LIMIT` entries and a malformed file is ignored, never trusted.

## Test

Offline (no model, no terminal, no network):

```bash
node tests/run.mjs                                   # data rules + the whole flow
node tests/load-check.mjs extensions/new-session/index.ts   # "commands: new-session", zero errors
npm run check                                        # both
```

`tests/run.mjs` covers the argument grammar (both flag forms, duplicates,
missing values, unknown flags, spacing kept in the text), pattern matching
(exact, bare id, credential preference, provider colons, `no-auth`, ambiguous,
substring of a display name), the shortlist order and its search row, effort rows
and the level precedence and clamping, branch reading (last assistant text,
compaction as its own turn, budgets, tool results excluded), the input source
rows including the disabled ones, the review block, the recent file (tolerant
read, newest-first write, cap), and the mailbox guard.

The flow itself is driven through faked dialogs. The fake `newSession()` runs
`session_start` and then `withSession`, in Pi's real order, so the suite asserts
`["setModel", "setThinkingLevel", "sendUserMessage"]` as a sequence — that is the
design's core claim. It also asserts: explicit arguments skip every picker but the
confirmation; a `no-auth` or unknown pattern explains itself and falls back to the
picker; an ambiguous search lists candidates; the handoff source calls the model
with the shipped system prompt and prefills the editor with the answer; an aborted
generation and an empty editor input both fall back instead of sending nothing; a
`discard` and a refused switch start nothing and leave no recent entry; and the
failure paths of the hand-off (no credentials, provider throws, model gone).

Manual check in the TUI, after `.\scripts\install.ps1` (or `-Link`) and `/reload`:

1. `/new-session` with no arguments → shortlist with the current model marked →
   `Enter` keeps it → effort → input source → review → `Yes`;
2. the new session opens with the footer showing the chosen model and effort, the
   prompt already running, and `/resume` listing the previous session;
3. `/new-session --model opus:high --effort low hello there` → only the review
   screen appears;
4. `/new-session --model nosuchmodel hi` → the "no model matches" warning, then the
   picker;
5. choose `Handoff prompt built from the last assistant message` in a session that
   has one → the loader appears, `Esc` cancels it and the editor opens empty
   instead;
6. run it on a model without reasoning (e.g. a plain GPT/Claude-haiku class model)
   → no effort dialog at all;
7. `Esc` at any step → "closed. This session is untouched." and the conversation
   you were in is still there.
