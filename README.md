# pi-settings

My [Pi](https://pi.dev) / Pi-Bolt customizations versioned in one place:
extensions, skills, prompt templates and themes. The repo is a valid **Pi
package** (`package.json` with the `pi` manifest), so it can be installed from
git or copied into `~/.pi/agent`.

```text
pi-settings/
├── package.json        # Pi package manifest (pi.extensions / skills / prompts)
├── extensions/         # TypeScript extensions (one file, or a directory with index.ts)
├── skills/             # one directory per skill, each with SKILL.md
├── prompts/            # prompt templates: the filename becomes the /command
├── plan-flow/          # phase instruction overrides for the plan extension (copied on install)
├── themes/             # JSON themes (created with the first one)
├── docs/               # long-form documentation per resource
├── tests/              # offline tests + host package stubs
└── scripts/            # install.ps1 / install.sh
```

## Extensions

| Extension | File | Command | Tools | What it does | Doc |
|---|---|---|---|---|---|
| **plan** | `extensions/plan.ts` | `/plan` | `plan_advance`, `plan_title` | Phased planning workflow (`investigate → summary → plan → ready`) with human approval, the plan written straight to a `.md` file, and a fresh session for implementation | [docs/plan.md](docs/plan.md) |

### `/plan` in one table

| Command | What it does |
|---|---|
| `/plan start <problem>` | starts in the investigation phase (sends the kickoff prompt) |
| `/plan summary` | asks for the summary (shortcut; the model can also request it via `plan_advance`) |
| `/plan approve` | approves the summary (→ planning, creates the file) / approves the plan (→ ready, offers a new session) |
| `/plan title <2-4 words>` | renames the plan (heading and file name) |
| `/plan back <phase>` | goes back to `investigate` \| `summary` \| `plan` |
| `/plan guard on\|off` | toggles the `edit`/`write` block in investigate/summary |
| `/plan status` | current state |
| `/plan stop` | turns the flow off |

What the extension does and does not protect: `edit`/`write` are blocked in
`investigate`/`summary`, but `bash` stays allowed — that is a workflow
convention, not a security boundary.

## Skills

| Skill | Directory | When to use | Doc |
|---|---|---|---|
| _(none yet)_ | — | — | — |

## Prompt templates

| Command | File | Arguments | What it does |
|---|---|---|---|
| _(none yet)_ | — | — | — |

## Install on another machine

Three paths. **Pick one per machine** — using two at the same time loads the same
extension twice (Pi warns about the duplicate `/plan` command).

### A. As a Pi package (no clone needed)

```bash
pi-bolt install git:github.com/edubrunaldi/pi-settings
pi-bolt list                      # check it
pi-bolt update --extensions       # update after a push
```

The managed clone lives in `~/.pi/agent/npm/`. Requires the repo to be pushed.

### B. Cloning the repo (repo = source of truth)

Windows (PowerShell) / Linux and macOS:

```powershell
git clone https://github.com/edubrunaldi/pi-settings.git
cd pi-settings
.\scripts\install.ps1            # copy into ~/.pi/agent
.\scripts\install.ps1 -Link      # or symlink (Windows: needs Developer Mode)
.\scripts\install.ps1 -DryRun    # only show what it would do
```

```bash
git clone https://github.com/edubrunaldi/pi-settings.git
cd pi-settings
./scripts/install.sh             # copy into ~/.pi/agent
./scripts/install.sh --link      # symlink, repo stays the source of truth
./scripts/install.sh --dry-run
PI_AGENT_DIR=/path/to/agent ./scripts/install.sh
```

The script backs up `*.bak-<timestamp>` whatever it overwrites, skips identical
files, and warns if the repo is also installed as a package.

### C. By hand

| From the repo | To |
|---|---|
| `extensions/*.ts` | `~/.pi/agent/extensions/` |
| `skills/<name>/` | `~/.pi/agent/skills/<name>/` |
| `prompts/*.md` | `~/.pi/agent/prompts/` |
| `themes/*.json` | `~/.pi/agent/themes/` |
| `plan-flow/*.md` (without `README.md`) | `~/.pi/agent/plan-flow/` |

### After installing

Restart Pi or run `/reload` in an open session. To check the extension:

```text
/plan status
```

## Test before installing

```bash
npm run check      # behavior tests + load check with Pi's real loader
```

No `npm install` needed: `tests/run.mjs` copies the stubs from `tests/stubs/` into
`node_modules/` on first run.

## What is not (and should not be) here

| Item | Why |
|---|---|
| `auth.json`, `models-store.json`, `sessions/`, `missions/` | credentials, state and history are per machine |
| `missions/`, `cache/`, `fff/`, `bin/` | generated artifacts |
| third-party npm packages | install them with `pi-bolt install`, or list them in `settings.json` → `packages` |

Suggested `settings.json` (not versioned, because it is per machine):

```json
{
  "piBolt": {
    "packages": [
      "npm:opensec-pi-todo@2.13.1",
      "npm:opensec-pi-fff@0.11.0",
      "npm:opensec-pi-subagents"
    ]
  }
}
```

## Adding new resources

Structure, conventions and per-type checklist: [AGENTS.md](AGENTS.md).
