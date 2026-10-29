# ask (Pi extension)

| | |
|---|---|
| Source in this repo | `extensions/ask/` (`index.ts`, `questionnaire.ts`, `logic.ts`) |
| Installed at | `~/.pi/agent/extensions/ask/` (or loaded straight from the repo as a Pi package) |
| Command | none |
| Tools | `ask` (always active) |
| Files it writes | none — no session entries, no state files |
| Tests | `node tests/run.mjs`, `node tests/load-check.mjs extensions/ask/index.ts` |

A question the model needs answered becomes a keyboard interaction instead of a
paragraph of prose the user has to type back into the editor.

```text
1 to 4 questions per call → one screen each, tab bar between them → answers come back as labels
```

The picker is drawn **inline**: it takes the editor area for the length of the
interaction (no overlay window), then gives it back. It reads no configuration
and owns no state between calls; the questions and the answers live only in the
tool result, which is also what `renderResult` redraws from after a resume.

## When the model should call it

The tool carries its own `promptSnippet` and `promptGuidelines`, so the rule
reaches every session without another extension restating it: ask through `ask`,
never in prose, batching every question in one call.

### The recommendation goes first

Every question carries a recommendation, and it is the **first** option, with the
word written in its label: `(recommended)`, or `(recomendado)` when the
conversation is in Portuguese. The rule is stated in three model-facing places —
the tool description, `promptGuidelines` and the `options` schema description —
and nowhere else: the picker does not reorder or annotate anything, so a call
that ignores it renders exactly as sent. It is a convention, not a validator; a
model that has no recommendation to give still has to pick the least bad option
and say so. Keeping the recommendation first also means the cursor's start
position is the answer most users accept with a single `Enter`.

## Tool input

```ts
{
  questions: [                      // 1 to 4
    {
      id: "scope",                  // snake_case, unique in the call
      header: "Scope",              // tab label, about 12 characters
      prompt: "How much should change?",
      type: "single",               // "single" (radio, default) or "multi" (checkbox)
      options: [                    // 2 to 8 declared options, best first
        { label: "Minimal (recommended)", description: "Retry only, one file." },
        { label: "Complete", description: "Retry plus quarantine." }
      ]
    }
  ]
}
```

`"Your own answer"` is appended as the **last** option of every question and can
never be turned off — so a question with 2 to 8 declared options always renders
3 to 9 rows. Limits and the free-form row are enforced by `logic.ts`: a call that
breaks them throws with the violated limit in the message, which the model sees
and can correct.

## Keys

| Key | What it does |
|---|---|
| `↑` `↓` | move the cursor within the current question |
| `Enter` | radio: answers that option and moves on; checkbox: moves on; free-form row: opens the text editor, or moves on when an answer is already written |
| `Space` | checkbox: tick or untick the row; free-form row: edit (radio) or tick and edit / untick and clear (checkbox) |
| `Tab`, `→` | next question |
| `Shift+Tab`, `←` | previous question |
| `Esc`, `Ctrl+C` | close without answering — works in every state, including inside the editor |
| typing, `Enter` in the editor | saves the written answer; submitting an empty one returns to the options without answering |

`↑`/`↓`, `Enter` and the cancel key are checked as Pi keybinding actions first
(`tui.select.up`, `tui.select.down`, `tui.select.confirm`, `tui.select.cancel`,
`tui.input.tab`) and only then as hard-coded keys, so a custom keymap keeps
working. With more than 8 rows the list windows around the cursor and shows
`↑ n more` / `↓ n more`.

## What the model gets back

```text
User answered 2 questions:
1. Scope (radio): "Minimal"
2. Tests (checkbox): "Unit", "Load check"; wrote: "plus the manual smoke"
```

`details` carries `{ cancelled, reason?, questions, answers }`, each answer being
`{ id, header, prompt, picks, labels, custom? }`. `picks` are indices into the
declared options plus the free-form row (`options.length`), so a written answer
in a radio question **replaces** the pick while in a checkbox question it is
**appended** as an extra label. Model-authored text is stripped of ANSI and
control characters before it reaches the screen or the model.

Cancelling returns `cancelled: true` with the text "the user closed the
questions without answering", which instructs the model to continue without
inventing an answer.

## Without a terminal

In `rpc`, `json`, `print` and subagent runs there is no custom UI to open, so the
tool returns `reason: "ui_unavailable"` and the questions come back as a list the
model is told to ask **in prose**. A picker that fails to open degrades the same
way: the turn is never lost to a UI problem. There is no RPC checkbox adapter —
that is a follow-up.

Two more runtime rules, both because a dialog is a hard place to fail:

- `executionMode: "sequential"` — the whole tool batch is serialized, so two
  `ask` calls can never race with an open picker;
- the run's abort signal resolves the open picker as cancelled, so a session
  replacement or an aborted run does not leave the terminal owned by a dead tool
  call.

## Deliberate exception to a repo rule

`AGENTS.md` asks that a tool stay out of the active set while its feature is off.
`ask` does not follow that: it is **always active**. A question can be needed in
any phase of any workflow, and switching it on per feature would need a signal
that does not exist yet. The cost is one `promptSnippet` line and four
`promptGuidelines` in every system prompt. Nothing toggles the active tool set,
so nothing has to keep it registered.

## Test

Offline (no model, no terminal):

```bash
node tests/run.mjs                              # data rules + tool contract
node tests/load-check.mjs extensions/ask/index.ts   # Pi's real loader: "tools: ask", zero errors
npm run check                                   # both
```

`tests/run.mjs` covers the limits (0/5 questions, 1/9 options, duplicate ids,
empty labels, the default `type`), the always-last free-form row, pick semantics,
the merge rules of `buildAnswers`, `formatAnswerText`, ANSI stripping, the tool
metadata (`promptSnippet`, ≥2 `promptGuidelines`, `sequential`, no
`defaultActive: false`), the `ui_unavailable` degrade and the throw on invalid
params.

Rendering and keyboard handling are TUI behavior and are verified by hand after
`.\scripts\install.ps1` (or `-Link`) and `/reload`:

1. ask for something that needs a decision → the picker appears where the editor was;
2. radio: `↑↓` then `Enter` answers;
3. checkbox: `Space` ticks several rows, all labels come back in one answer;
4. `Your own answer` is the last row, opens the inline editor, replaces the pick
   in radio and is appended in checkbox;
5. `Esc` closes from the list, from the editor, and after moving between tabs;
6. resize the terminal while it is open — nothing exceeds the width and the
   layout reflows;
7. inside `/investigate`, the model asks through `ask` instead of prose.

## Known limitations

- No mouse support: every interaction is keyboard-only by design.
- No overlay mode: the picker replaces the editor area, so it cannot be shown on
  top of another dialog.
- Long questions and options wrap; at a very narrow width the row numbering and
  the editor border stay readable but the layout gets tall.
- The picker is per call: nothing is remembered between two `ask` calls, and the
  answers are not stored anywhere except in the tool result.
