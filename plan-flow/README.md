# plan-flow — phase instruction overrides

`extensions/plan.ts` ships embedded instructions for every phase. This directory
is the **source of truth for the overrides**: any `*.md` here (except this
README) is copied to `~/.pi/agent/plan-flow/` by `scripts/install.ps1` /
`scripts/install.sh`.

The extension only reads overrides from the agent directory, never from here:

```text
~/.pi/agent/plan-flow/common.md       rules appended to every phase
~/.pi/agent/plan-flow/investigate.md
~/.pi/agent/plan-flow/summary.md
~/.pi/agent/plan-flow/plan.md
~/.pi/agent/plan-flow/ready.md
```

Rules that must survive an override:

- keep the `plan_title` / 2-to-4-word title guidance;
- keep "the plan file holds the plan and nothing else";
- keep `${planPath}`, which the extension replaces with the real file path in
  `plan.md` and `ready.md`.

Remove a file here (and from `~/.pi/agent/plan-flow/`) to fall back to the
embedded default for that phase. Run `/reload` after changing an override.
