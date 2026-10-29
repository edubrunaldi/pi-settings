# plan prompts (prompt templates)

| | |
|---|---|
| Source in this repo | `prompts/investigate.md`, `prompts/write-plan.md` |
| Installed at | `~/.pi/agent/prompts/` |
| Commands | `/investigate`, `/write-plan` |
| Tools | none of their own — they are prompt templates, plain text expanded into your message |
| Doc | this file |

Two independent prompt templates for machines and hosts where the [`plan` extension](plan.md) is not
installed or not wanted. Neither one knows about the other: `/investigate` writes a report,
`/write-plan` writes a file, and you choose which to run and when. There is no state and no
enforcement — the rules live in the prompt, so they hold only as far as the model follows them.

```text
/investigate <task>   →  a findings report in the chat, and nothing else
/write-plan [path]    →  the plan, written straight into .pi/plans/<stamp>-<slug>.md
```

## Commands

| Command | Arguments | What it does |
|---|---|---|
| `/investigate` | `<task>` | read-only investigation that exhausts the repository first, asking only decisions that are the user's, and ends in a six-part findings report — the report is the deliverable, and it stops there |
| `/write-plan` | `[plan-file-path]` | writes the executable plan **into the file**, never into the chat; without an argument it derives subject, title and path itself, fills gaps from the repository and asks only real user decisions before writing |

Arguments follow shell-like quoting, so `/investigate "fix the pricing tab autosave"` is one task.

## How the two relate

They do not chain. Each command stands on its own:

1. `/investigate` ends with the report in the chat. No file is written, no title is proposed and no
   approval is requested: investigating is a legitimate end state, not a step towards something else.
2. `/write-plan` works from whatever investigation is in that conversation — from `/investigate`, from
   earlier work in the same session, or from nothing at all. When the context is not enough to plan
   from, it investigates and asks first; when there is no subject at all, it asks what to plan.
3. Because the plan file is self-contained by design, it can be handed to a different session than
   the one that wrote it.

The plan file convention: `<project>/.pi/plans/YYYYMMDD-HHMMSS-<title-slug>.md`, first line
`# <title>`, body = the plan and nothing else (no investigation summary, no transcript, no metadata).
Decide per repository whether `.pi/plans/` is versioned or ignored.

## Asking

Both templates investigate before they speak. Instructions, code and its callers, `git log` / `blame`
/ `diff`, tests and fixtures, configuration and anything the code links to are read first; subagents
fan out when the surface is broad. A decision that can be defended from evidence becomes a stated
hypothesis or recommendation, not a question.

A question then has to pass four tests: the repository cannot answer it, it belongs to the user
(scope, priority, taste, risk, business rule, external constraint), either answer changes the result,
and nobody has answered it already. Questions arrive in batches of 1 to 4, each with the finding that
motivated it, the fork it creates, 2 to 6 concrete options with their consequences, and the option
the model would pick. Never "which files matter?" or "should I continue?".

## Prompts or extension?

| | `/plan` extension | these prompts |
|---|---|---|
| Phase state | real, persisted in the session (`/plan status`, survives resume) | none — each command runs alone and forgets |
| `edit`/`write` blocked while investigating | yes (and `bash` still allowed, so it is a convention, not a boundary) | no — instruction only |
| Approvals | dialog + `/plan approve`; a phase never advances by itself | none — nothing to approve, no next command to run |
| Plan file | created on approval, renamed by `plan_title`, validated before `/plan approve` | created by `/write-plan` from the template's rules; nothing validates it |
| Status line / widget | yes | no |
| Works where extensions cannot load | no | yes |

Use the extension where it is installed; use the prompts elsewhere, or when you want a single command
(one report, or one file) without the dialogs. Do not expect the two to share state: `/plan status`
knows nothing about a plan written by `/write-plan`, and neither prompt moves the extension's phase.

## Name collisions

`/plan` belongs to the extension, which is why no template here is called `plan.md` — an extension
command with the same name wins, and Pi reports the collision at startup. If you install the example
`plan-mode` extension, note that it also registers `/plan` and reads `Plan:` / `[DONE:n]` markers from
the chat; these templates deliberately do not use those markers and track no progress of their own.

## Limitations

- Nothing is enforced. A template is text: if the model edits a file during `/investigate`, no guard
  stops it. The `plan` extension's guard is the real thing.
- `/write-plan` without an argument has to judge on its own whether the conversation holds enough
  investigation; a thin context gets a thin plan, and the prompt's "investigate first" rule is the
  only defence.
- No title validation: the 2-to-4-word rule is a request, not a check, and the file name is whatever
  the model writes (the extension renames the file when the title changes).
- No approval record and no implementation command. These templates stop at the report and at the
  plan file; hand the file to a session of your choosing.
- Timestamps come from `date +%Y%m%d-%H%M%S` in the shell; a host without a POSIX `date` needs the
  path passed explicitly to `/write-plan`.

## Install and test

Local package mode — nothing is copied, Pi loads the clone directly:

```bash
pi-bolt install /absolute/path/to/pi-settings
pi-bolt list
```

Copy mode, on a machine where the clone is not registered as a package:

```powershell
.\scripts\install.ps1 -DryRun     # see what lands where
.\scripts\install.ps1             # copies prompts/*.md into ~/.pi/agent/prompts/
```

```bash
./scripts/install.sh --dry-run
./scripts/install.sh
```

Copy mode backs a replaced **directory** up as `<dir>.bak-<stamp>` inside the same folder, and Pi's
extension discovery loads any subdirectory of `~/.pi/agent/extensions/` that holds an `index.ts`. A
backup of `ask/` would therefore register the `ask` extension twice: delete `*.bak-*` from
`~/.pi/agent/extensions/` after installing, or use the local package mode, which makes no backup.

Then `/reload` in an open session (templates are read at startup) and check that both commands appear
in the `/` completion. Markdown-only resources have no behavior test; `npm run check` covers the
extensions.

To confirm what Pi will actually load, resolve the resources with Pi's own loader:

```js
const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent/dist/core/resource-loader.js");
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: "<agent dir>" });
await loader.reload();
console.log(loader.getExtensions().extensions.map((e) => e.path));
console.log(loader.getPrompts().prompts.map((t) => `/${t.name}`));
```
