# Logic Prototype

A tiny interactive terminal app that lets the user drive a state model by hand.
Use this when the question is about **business logic, state transitions, or data
shape** — the kind of thing that looks reasonable on paper but only feels wrong
once you push it through real cases.

## When this is the right shape

- "I'm not sure if this state machine handles the edge case where X then Y."
- "Does this data model actually let me represent the case where..."
- "I want to feel out what the interface should look like before writing it."
- Anything where the user wants to **press buttons and watch state change**.

If the question is "what should this look like" — wrong branch. Use
[UI.md](UI.md).

## Process

### 1. State the question

Before writing code, write down what state model and what question you're
prototyping. One paragraph, in the prototype's README or a comment at the top of
the file. A logic prototype that answers the wrong question is pure waste — make
the question explicit so it can be checked later, whether the user is watching
now or returning to it AFK.

### 2. Pick the language

Use whatever the host project uses. If the project has no obvious runtime, ask.

Match the project's existing conventions for tooling — don't add a new package
manager or runtime just for the prototype.

### 3. Isolate the logic in a portable module

Put the actual logic — the bit that's answering the question — behind a small,
pure interface. The TUI around it is throwaway; keeping the state module
portable lets the later Implement owner reproduce the validated design without
inheriting terminal concerns or prototype shortcuts.

The right shape depends on the question:

- **A pure reducer** — `(state, action) => state`. Good when actions are discrete
  events and state is a single value.
- **A state machine** — explicit states and transitions. Good when "which actions
  are even legal right now" is part of the question.
- **A small set of pure functions** over a plain data type. Good when there's no
  implicit current state — just transformations.
- **A class or module with a clear method surface** when the logic genuinely owns
  ongoing internal state.

Pick whichever shape best fits the question being asked, *not* whichever is
easiest to wire to a TUI. Keep it pure: no I/O, no terminal code, no
`console.log` for control flow. The TUI imports it and calls into it; nothing
flows the other direction.

The portable module is still prototype evidence, not production code.
Production delivery returns to `$implement` for its normal tests, error handling,
proof, and Review.

### 4. Build the smallest TUI that exposes the state

Build it as a **lightweight TUI** — on every tick, clear the screen
(`console.clear()` / `print("\033[2J\033[H")` / equivalent) and re-render the
whole frame. The user should always see one stable view, not an ever-growing
scrollback.

Each frame has two parts, in this order:

1. **Current state**, pretty-printed and diff-friendly (one field per line, or
   formatted JSON). Use **bold** for field names or section headers and **dim**
   for less important context (timestamps, IDs, derived values). Native ANSI
   escape codes are fine — `\x1b[1m` bold, `\x1b[2m` dim, `\x1b[0m` reset. No
   need to pull in a styling library unless one is already in the project.
2. **Keyboard shortcuts**, listed at the bottom: `[a] add user  [d] delete user
   [t] tick clock  [q] quit`. Bold the key, dim the description, or vice-versa —
   whatever reads cleanly.

Behaviour:

1. **Initialise state** — a single in-memory object or struct. Render the first
   frame on start.
2. **Read one keystroke (or one line)** at a time, dispatch to a handler that
   changes the in-memory state.
3. **Re-render** the full frame after every action — don't append, replace.
4. **Loop until quit.**

The whole frame should fit on one screen.

### 5. Make it runnable in one command

Add a script to the project's existing task runner (`package.json` scripts,
`Makefile`, `justfile`, `pyproject.toml`). The user should run
`pnpm run <prototype-name>` or equivalent — never need to remember a path.

If the host project has no task runner, put the command at the top of the
prototype's README.

### 6. Hand it over

Give the user the run command. They'll drive it themselves; the interesting
moments are when they say "wait, that shouldn't be possible" or "huh, I assumed
X would be different" — those are the bugs in the *idea*, which is the whole
point. If they want new actions added, add only those needed to answer the same
question.

### 7. Capture the answer and clean up

Once the prototype has answered its question, record the verdict and the
question it settled outside the throwaway code. Remove the TUI and state module,
or leave them only in an explicit repository prototype area. Do not create a
branch or commit: Prototype creates no Git action. Give the validated state
model and run command to `$implement` as evidence for separately authorized
production work.

## Anti-patterns

- **Don't add broad tests.** A prototype that needs production-grade coverage is
  no longer a bounded prototype.
- **Don't wire it to the real database.** Use an in-memory store unless the
  question is specifically about persistence, then use an isolated scratch
  store.
- **Don't generalise.** No "what if we wanted to support X later." The prototype
  answers one question.
- **Don't blur the logic and the TUI together.** If the reducer or state machine
  references terminal output, prompts, or escape codes, it's no longer portable.
  Keep the TUI as a thin shell over a pure module.
- **Don't ship the TUI shell or portable module into production.** They were
  built under prototype constraints. Implement owns the production version.
