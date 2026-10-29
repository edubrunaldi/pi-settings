---
description: Write an executable plan straight into a markdown file, never into the chat
argument-hint: "[plan-file-path]"
---
Plan file: ${@:-DERIVE}

Write the executable plan into a markdown file and stop there. Whoever implements it will read the
file alone, with no access to this conversation — so everything they need must be inside the file.

Ask through the `ask` tool when the host provides it (otherwise ask in prose, batched in a single
message). Answer in the user's language.

## What you plan from

- A path above: write the plan there. When the file already exists, read it first and preserve manual
  edits.
- `DERIVE`: subject, title and path come from you. Before writing, say in one line which context you
  are planning from.
- Use the investigation already in this conversation only when it is enough to plan from — enough
  meaning you can answer all of these without guessing: which files each step touches (read, not
  just mentioned), the invariants and conventions that must keep holding, the decisions the user
  already made, and the commands that will prove each step worked. Any gap is yours to fill first.
- Fill it from the repository, not from the user: the module and its callers, its types and schemas,
  its tests and fixtures, the project instructions, configuration, and the history
  (`git log --oneline -20`, `git log -S<symbol>`, `blame`, `diff` for work in progress). Fan out
  across exploration subagents when the surface is broad, and never ask the user to summarise their
  own codebase.
- A wish with nothing read or verified ("we should fix X") is not investigation: investigate first —
  read the real files, follow the same threads an investigation would — and only then write the
  plan. If there is no subject at all, ask what to plan and wait; do not invent a scope.

## Where to write

- Title: 2 to 4 words naming the solution, not the sentence the user typed.
- Path: `<project>/.pi/plans/<YYYYMMDD-HHMMSS>-<title-slug>.md`, with the timestamp from
  `date +%Y%m%d-%H%M%S`; reuse the project's existing plans directory when it has one, and create the
  directory if needed.
- When the argument above already names the file, write exactly there and skip the derivation.
- The first line of the file is `# <title>`. If what you found stops fitting that title, rename it
  (heading and file) and say so in one line.

## The file holds only the plan

Title heading plus plan body. No summary of the investigation, no conversation transcript, no status
line, no metadata, no changelog of your own edits. The plan file is the source of truth: **never
paste the plan into the chat**. After each update reply with only the file path, a one-line status,
and any open question or what changed.

The plan must contain:

- **Goal, scope and non-goals.**
- **Required context** — files, components, contracts and invariants with real paths (`file:symbol`),
  plus the project conventions the implementer must obey (from `AGENTS.md` or equivalent) and how to
  run the thing being changed.
- **Numbered steps in executable order** — what to change, why, the risk of the step, and how to
  check it. Small enough that each one can be finished and verified on its own.
- **Edge cases and error handling** — attached to the step that causes them, not in a generic
  paragraph at the end.
- **Validation** — the exact commands to run and the verifiable acceptance criteria they must produce.
- **Pending items and prerequisites** — migrations to apply, credentials, access, decisions still open.

## Ask only what is yours to ask

- Ask only when the repository cannot answer it and the answer is the user's: scope, priority, taste,
  risk, a business rule, an external constraint. Never ask which files matter, which command proves
  the change, how the project is laid out, where the file goes, or whether to continue — those are
  yours to find.
- A decision you can defend from evidence is not a question: write it into the plan with the reasoning
  and let the user correct it.
- When the question is real, batch 1 to 4, each opening with the finding that motivated it, the fork
  it creates, 2 to 6 concrete options with the consequence of each, and the option you would choose
  and why. Through the `ask` tool when the host provides it; otherwise prose with options. No
  questionnaires, and nothing this conversation already answered.
- If an answer contradicts a decision already made in this conversation, say so and confirm the new
  direction before continuing.

## Rules

- Keep investigating in this phase: a doubt that lives in the code, config or history is yours to
  settle. Questions and answers stay in the chat; the plan stays in the file.
- Do not implement anything here and do not modify source files: the plan file is the only file you
  write in this phase. Reading and read-only commands are fine.
- On a change request, read the plan file first, edit it in place, and reply with a short summary of
  what changed — never the plan itself.

When the plan is finished, report the path and say: "Plan ready in the file above. Review it before
handing it to an implementation session."
