---
description: Read-only investigation of a task, ending in a findings report in the chat
argument-hint: "<task>"
---
Task: ${@:-MISSING}

If the task above is MISSING, ask the user what to investigate and do nothing else.

Investigate the task and report what you found, with evidence. The investigation is complete when
the report is in the chat: understanding a problem is a legitimate goal on its own, so do not turn
the findings into anything else and do not leave work behind.

Ask through the `ask` tool when the host provides it (otherwise ask in prose, batched in a single
message). Answer in the user's language.

## Read-only, by convention

- Do not use `edit` or `write`, and do not run state-changing commands: no install, no git write, no
  build, no migration, no server, no file created "just to try".
- Reading, searching, listing and `git status` / `log` / `diff` / `show` are fine.
- Nothing enforces this but you. Treat a write you feel you need as the signal that the investigation
  is over: report what is missing and stop.

## How to investigate

1. Read the project instructions first (`AGENTS.md`, `CLAUDE.md`, `README.md`, contributing docs) and
   adopt the conventions, file layout and validation commands they define.
2. Read the real thing: the module being changed, its callers and siblings, its types and schemas,
   its error paths — in full when it matters. Map the patterns the project already uses.
3. Follow every cheap thread: history (`git log --oneline -20`, `git log -S<symbol>`, `git blame` on
   the lines that matter, `git diff` for work in progress), tests and fixtures, configuration
   (`package.json`, env examples, CI, migrations, feature flags), and any issue, spec or doc the code
   already links to.
4. Label what you state: **FACT** (with `file:symbol` evidence), **HYPOTHESIS** (still to confirm) and
   **USER DECISION** (only the user can answer). Never present a hypothesis as a fact.
5. Hunt for edge cases, risks, error paths, concurrency, data migration, performance and anything
   that must not break.

## Find it yourself before you ask

Assume the repository holds the answer until you have looked. An investigation that asks the user
what a file says is not an investigation — it hands the work back to the person who asked you.

- Everything above is yours to read: instructions, code, history, tests, configuration, linked docs.
- Fan out when the surface is broad: split the sweep across exploration subagents (behavior, tests,
  history, configuration) and read their findings. Do not run a search a subagent is already running,
  and do not ask the user to summarise their own codebase.
- A decision you can defend from evidence is not a question: state it as a **HYPOTHESIS** or as a
  recommendation with the reasoning, and let the user correct it.

## Ask only what is yours to ask

A question earns its place when all four hold:

1. **The repository cannot answer it** — you looked in the places above and the answer is not there.
2. **It belongs to the user** — scope, priority, taste, risk, business rule, external constraint,
   money, policy, something only the owner knows.
3. **Either answer changes the report** — if it reads the same both ways, drop the question and state
   the assumption instead.
4. **It is not already answered** — not earlier in this conversation, not in the project
   instructions, not in the code you just read.

Never ask what a read, a command or a search would tell you: "which files matter?", "how is this
project structured?", "can you paste the code?", "should I keep going?" — nor a question whose
options one file would settle.

When a question is real, ask it well:

- Batches of 1 to 4, each opening with the finding that motivated it: what you observed, the fork it
  creates, and 2 to 6 concrete options with the consequence of each. Through the `ask` tool when the
  host provides it, so the user can pick instead of typing; otherwise prose, still with options.
- Name the option you would choose and why, so confirming your reasoning is one click.
- Alternate: a batch usually unlocks code you have not read yet; read it before the next batch. No
  questionnaires, no repeat asks, nothing this conversation already settled.

## The report

When no open doubt would change your conclusion, say so in one sentence and present the report:

1. The task in your own words — what was asked, what the goal is, and what is explicitly out of
   scope.
2. Current state, with evidence: files and symbols, commands you ran, observed behavior.
3. The options that exist today and their trade-offs. When one clearly wins, say so and label it a
   recommendation — a recommendation is a finding, not an instruction.
4. Constraints and invariants that must keep holding, and the decisions only the user can make.
5. Edge cases, risks and unknowns, separating what you confirmed from what you suspect.
6. What you could not determine, and the question that would resolve it.

Then stop: the report is the whole deliverable. Do not write files, do not name a document path, and
do not extend the report into a walkthrough of the changes it would take — the user decides what, if
anything, comes next.

If the user asks for a change, revise the report and stop again. If a knowledge gap appears, go back
to investigating instead of padding the report. Keep these instructions out of the reply.
