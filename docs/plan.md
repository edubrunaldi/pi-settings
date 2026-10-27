# plan (Pi extension)

| | |
|---|---|
| Source in this repo | `extensions/plan.ts` |
| Installed at | `~/.pi/agent/extensions/plan.ts` (or loaded straight from the repo as a Pi package) |
| Command | `/plan` |
| Tools | `plan_advance`, `plan_title` (inactive while the flow is off) |
| Instruction overrides | `~/.pi/agent/plan-flow/*.md` — source kept in [`plan-flow/`](../plan-flow) |
| Tests | `node tests/run.mjs`, `node tests/load-check.mjs` |

A phased planning workflow with human approvals, a plan written directly to a
markdown file, and a fresh session for implementation.

```text
investigate ⇄ questions  →  summary (waits for you)  →  planning ⇄ questions  →  plan file (you review it)  →  /plan approve  →  new session
```

There is no activation step. Pi loads the extension at startup, so you only type
`/plan start <problem>`. `/plan` alone prints the current state.

## Usage

```text
/plan start <problem>     begin in the investigation phase (the kickoff prompt is sent, not staged)
/plan summary             request the summary (shortcut; the model can also ask via plan_advance)
/plan approve             approve the summary (→ planning, creates the plan file); approve the plan file (→ ready, offers a new session)
                          in ready phase, repeat to offer the new session again
/plan title <2-4 words>   rename the plan: rewrites the heading and the file name
/plan back <phase>        investigate | summary | plan
/plan guard on|off        toggle the edit/write block
/plan status              current state
/plan stop                turn the flow off
```

The model calls the `plan_advance(to, reason, title?)` tool to **request** a
transition; it only happens if you confirm in the dialog. No phase advances by
matching words in the model's answer. `plan_title(title)` sets the short plan
title once the problem is understood; it is 2 to 4 words naming the solution and
becomes both the plan heading and the file name.

Both tools stay out of the model's tool list while the flow is off, so
installing this extension user-wide does not change unrelated sessions.

## Output files

Approving the summary immediately creates
`<project>/.pi/plans/YYYYMMDD-HHMMSS-<title-slug>.md`. The title is chosen by the
model (`plan_title`, or the `title` parameter of `plan_advance`), never the text
you typed in `/plan start`; if the model does not supply one, the summary heading
is used as a fallback.

The file contains **only the plan**:

```markdown
# <2 to 4 word title>

1. ...the plan itself...
```

While the plan is being written, the body is a single placeholder comment. There
is no summary, no conversation transcript, no status line and no session
metadata in the file.

The agent investigates any remaining doubts, still asks questions in the chat
when a decision is needed, and writes the complete plan **directly into that
file**. Plan content is never copied to the chat: each update gets a short
response with the file path, status and change summary. Corrections requested in
the chat are applied in place, after reading the file so manual edits are
preserved.

When you are happy with the file, `/plan approve` reads it (it refuses while the
placeholder or an empty body remains) and records the approval in the session
state. It does not rewrite the plan content.

The approval dialog asks whether to create a new session. Declining keeps the
approved file and phase; run `/plan approve` again to retry. If accepted, model,
thinking level and session name can be selected. The new session then receives
this prompt as a sent message (no second Enter):

```text
Plan file: `.pi/plans/<file-name>.md` Read this file first and treat it as the source of truth for implementation.
```

No plan content is copied into that prompt. Decide per repository whether
`.pi/plans/` is versioned or ignored.

## Customize the instructions without editing code

Drop markdown here and it replaces the embedded text of that phase:

```text
~/.pi/agent/plan-flow/common.md       (rules for every phase)
~/.pi/agent/plan-flow/investigate.md
~/.pi/agent/plan-flow/summary.md
~/.pi/agent/plan-flow/plan.md
~/.pi/agent/plan-flow/ready.md
```

Commit those files to `plan-flow/` in this repo: the install scripts copy them to
`~/.pi/agent/plan-flow/`, so a new machine gets the same wording. Overrides must
keep the title/`plan_title` guidance and the "plan only" rule for the file; the
extension depends on the title tool to name the plan.

Run `/reload` (or start a new session) after changing the extension or an
override.

## Naming notes

- The command you type comes from `registerCommand("plan", …)`, not from the file
  name. The file name only labels diagnostics and the `/reload` output.
- `/plan` is not a built-in Pi command and no skill or prompt template owns that
  name here. If you later install the example `plan-mode` extension, or add a
  skill/prompt named `plan`, the first registration wins and the collision is
  reported as a warning at startup.
- Internal ids are prefixed `plan-flow` (session entries, prompt section
  `plan_flow`, status/widget keys, this override directory). If you want a
  `/flow` alias, add one `registerCommand("flow", { …, handler })` delegating to
  the same handler.

## Known limitations (v0)

- The guard covers `edit`/`write` in the `investigate` and `summary` phases only.
  **`bash` is still allowed**, so this is a workflow convention, not a security
  boundary. Use a sandbox or isolation for a real boundary.
- Without an interactive UI, transitions requested by the model are refused and
  the extension tells you to use `/plan`.
- Visual features (status, widget) depend on the host: full in the terminal; in
  RPC-based integrations (for example Air) each one has to be verified.
- Auto-sending the kickoff/handoff prompt uses the host's `sendUserMessage`. When
  it is unavailable (or the agent is busy) the prompt falls back to the editor,
  and you press Enter as before.
- Without an interactive UI, `/plan approve` still approves the plan file and
  prints the short file-reference prompt for a manually opened session.

## Test

Offline tests (no model calls) live in `tests/` and run against
`extensions/plan.ts` directly:

```bash
node tests/run.mjs         # behavior, with a stub pi API + fake dialogs
node tests/load-check.mjs  # real Pi extension loader: registration without model calls
npm run check             # both
```

`tests/run.mjs` copies the host stubs from `tests/stubs/` into `node_modules/` on
first run, so a fresh clone needs no install step. `tests/load-check.mjs` locates
Pi's real loader automatically (override with `PI_CODING_AGENT_LOADER` or
`PI_CODING_AGENT_PACKAGE`).

`run.mjs` covers phase transitions, invalid jumps, the edit guard, tool
activation, draft creation at summary approval, the model-chosen title (heading,
file name and rename), writing the plan in the file, approval without rewriting
it, the cross-session handoff (model/thinking/name plus the prompt being sent,
not staged), guard toggle, `/plan back` and resume. The local `node_modules/`
stubs `typebox` and the pi packages; `load-check.mjs` instead runs Pi's real jiti
loader.
