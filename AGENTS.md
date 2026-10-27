# AGENTS.md

Instructions for AI agents working **in this repository**. Read this before adding
or changing anything here.

## What this repo is

Personal Pi / Pi-Bolt customizations, versioned as a single **Pi package**:

```text
pi-settings/
├── package.json        # pi manifest: extensions, skills, prompts (+ themes when added)
├── extensions/         # TypeScript extensions: one file, or a directory with index.ts
├── skills/             # one directory per skill, each with SKILL.md
├── prompts/            # prompt templates: filename == command name
├── plan-flow/          # phase-instruction overrides for extensions/plan.ts
├── themes/             # JSON themes (not created yet)
├── docs/               # long-form docs, one file per resource
├── tests/              # offline tests + host stubs (tests/stubs)
└── scripts/            # install.ps1, install.sh
```

Two consumption modes, never both at once on one machine:

| Mode | How | Where the code lives |
|---|---|---|
| Pi package | `pi-bolt install git:github.com/edubrunaldi/pi-settings` | `~/.pi/agent/npm/` (managed clone) |
| Repo + script | `./scripts/install.sh` / `.\scripts\install.ps1` | copied (or symlinked) into `~/.pi/agent/` |

## Non-negotiables

1. **The repo is the source of truth.** Never make `~/.pi/agent/extensions/*` the
   only copy of a change. Edit here, then re-run the install script.
2. **Host packages are `peerDependencies` only** (`@earendil-works/pi-ai`,
   `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`,
   `@earendil-works/pi-tui`, `typebox`). Never put them in `dependencies`: a
   second physical copy breaks Pi's module mapping. Real third-party runtime deps
   belong in `dependencies`.
3. **No generated state in git**: no `node_modules/`, `session*`, `auth.json`,
   `missions/`, `cache/`, `*.bak-*`, `.pi/plans/`.
4. **Update the tables.** `README.md` has one table per resource type; a new
   resource that is not listed there does not exist for the human reading it.
5. **Run `npm run check` before claiming done.** It runs the behavior tests and
   Pi's real extension loader; both must pass.
6. **Docs in English inside code and AGENTS.md; README and user-facing strings in
   Portuguese.** Chat replies to the user: Portuguese.

## Add an extension

1. Create `extensions/<name>.ts` exporting a default factory:
   ```ts
   import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
   export default function (pi: ExtensionAPI) { /* register tools/commands/events */ }
   ```
   A multi-file extension becomes `extensions/<name>/index.ts`.
2. Conventions followed by `extensions/plan.ts` — copy them:
   - do not start processes/sockets/timers in the factory; use `session_start`;
   - keep tools *out* of the active set while the feature is off
     (`pi.setActiveTools`), so a user-wide install does not change unrelated
     sessions;
   - persist state through `pi.appendEntry` and restore from
     `ctx.sessionManager.getBranch()`; keep per-user files under `getAgentDir()`
     or project files under `ctx.cwd`;
   - never infer a human decision — ask through `ctx.ui.confirm`/command;
   - comment the phase machine / invariants at the top of the file.
3. Documentation goes to `docs/<name>.md`: what it does, command table, files it
   writes, limitations, how to test.
4. Tests: add a case to `tests/run.mjs` (stub `pi` API, no model calls) and make
   sure `node tests/load-check.mjs` loads it with zero `errors`.
5. Add the row to the **Extensions** table in `README.md` (file, command, tools,
   purpose, doc link) and any command table it needs.
6. If the extension reads extra files from the agent dir (like `plan-flow/`),
   keep those files in a repo directory with the same name and make both install
   scripts copy them.

## Add a skill

1. `skills/<name>/SKILL.md` with frontmatter; supporting files live in the same
   directory (`scripts/`, `references/`, `assets/`).
   ```markdown
   ---
   name: <name>
   description: What it does and WHEN to use it — this drives model routing.
   ---
   ```
2. Refer to bundled files with paths relative to the skill directory.
3. Add the row to the **Skills** table in `README.md`.
4. Nothing to install by hand: `scripts/install.*` copies every directory that
   contains `SKILL.md`.

## Add a prompt template

1. `prompts/<command>.md` — **the filename is the command** (`prompts/review.md`
   → `/review`). Do not add a `README.md` inside `prompts/`: it would become a
   `/README` command.
2. Frontmatter: `description:` (shown in completion) and optional
   `argument-hint:` with `<required>` / `[optional]`.
3. Use `$1`, `$@`, `${1:-default}`, `${@:N}` for arguments.
4. Add the row to the **Prompt templates** table in `README.md`.

## Add a theme

`themes/<name>.json`, activate with `"theme": "<name>"`, add the row to a table in
`README.md`. The installer copies `themes/*.json` automatically.

## Test and verify

```bash
npm run check                     # behavior tests + real loader check
node tests/run.mjs                # stub pi API, fake dialogs, no model calls
node tests/load-check.mjs         # Pi's jiti loader: registration only
node tests/load-check.mjs extensions/plan.ts
```

`tests/run.mjs` copies `tests/stubs/` into `node_modules/` on first run, so a
fresh clone needs no install step. `tests/load-check.mjs` finds Pi's loader
automatically; override with `PI_CODING_AGENT_LOADER` (full path to
`dist/core/extensions/loader.js`) or `PI_CODING_AGENT_PACKAGE`.

Install verification after changing the scripts or adding a resource:

```powershell
.\scripts\install.ps1 -DryRun     # see exactly which files would land where
.\scripts\install.ps1
```

```bash
./scripts/install.sh --dry-run
./scripts/install.sh
```

Then restart Pi or `/reload` — a running session keeps the old extension code.

## Gotchas

| Symptom | Cause |
|---|---|
| `/plan` registered twice, startup warning | repo installed as package **and** copied by the script. Remove one (`pi-bolt remove <source>` or delete the copies). |
| Extension change has no effect | `/reload` not run, or you edited the repo while a *copied* install is the loaded one (re-run the script or use `--link`/`-Link`). |
| Overrides at `plan-flow/*.md` ignored | the extension reads `~/.pi/agent/plan-flow/`, not the repo directory; run the installer. |
| `typebox`/`@earendil-works` module not found at runtime | those are host-provided; keep them in `peerDependencies`, never `dependencies`. |
| Test import fails with `ERR_MODULE_NOT_FOUND` | `node_modules/` stubs missing; run `node tests/run.mjs` once (it seeds them) or `rm -rf node_modules` and retry. |

## Definition of done

- [ ] Resource added under the right directory, named per convention.
- [ ] `npm run check` green (new behavior has a test when it is code).
- [ ] `README.md` tables updated; `docs/<name>.md` added or updated.
- [ ] `package.json` manifest still matches the directory layout (no stale paths).
- [ ] No secrets, sessions, backups or `node_modules` staged.
- [ ] If behavior changed for the user: say so in one line in the reply.
