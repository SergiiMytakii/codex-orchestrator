# UI Prototype

Generate **several radically different UI variations** on a single route,
switchable from a floating bottom bar. The user flips between variants in the
browser, picks one (or steals bits from each), then throws the prototype away.

If the question is about logic or state rather than what something looks like —
wrong branch. Use [LOGIC.md](LOGIC.md).

## When this is the right shape

- "What should this page look like?"
- "I want to see a few options for this dashboard before committing."
- "Try a different layout for the settings screen."
- Any time the user would otherwise spend a day picking between three vague
  mockups in their head.

## Two sub-shapes — strongly prefer sub-shape A

A UI prototype is much easier to judge when it's **butting up against the rest
of the app** — real header, real sidebar, representative data, real density. A
throwaway route on its own is a vacuum: every variant looks fine in isolation.
Default to sub-shape A whenever there's a plausible existing page to host the
variants. Only reach for sub-shape B if the prototype genuinely has no nearby
home.

### Sub-shape A — adjustment to an existing page (preferred)

The route already exists. Variants are rendered **on the same route**, gated by
a `?variant=` URL search param and the repository's existing development-only
prototype convention. Existing read-only data fetching, params, auth, shell,
and density stay — only the rendered subtree swaps. This is the default; pick it
unless there's a specific reason not to.

If the prototype is for something that doesn't yet have a page but *would
naturally live inside one* — a new dashboard section, a new settings card, or a
new step in an existing flow — that's still sub-shape A. Mount the variants
inside the host page's development-only prototype surface.

### Sub-shape B — a new page (last resort)

Only use this when the thing being prototyped genuinely has no existing page to
live inside — for example an entirely new top-level surface or a flow that can't
be embedded anywhere sensible.

Create a **throwaway route** following whatever routing convention the project
already uses — don't invent a new top-level structure. Name it so it's obviously
a prototype, such as including `prototype` in the path or filename. Use the same
`?variant=` pattern.

Before committing to sub-shape B, sanity-check: is there really no existing page
this could be embedded in? An empty route hides design problems that a populated
one would expose.

In both sub-shapes the floating bottom bar is identical. Neither sub-shape may
perform real production mutations: use read-only data or stubs.

## Process

### 1. State the question and pick N

Default to **3 variants**. More than 5 stops being radically different and
starts being noise — cap there.

Write down the plan in one line, in the prototype's location or a top-of-file
comment:

> "Three variants of the settings page, switchable via `?variant=`, on the
> existing `/settings` route."

This works whether the user is here to push back or not.

### 2. Generate radically different variants

Draft each variant. Hold each one to:

- The page's purpose and the data it has access to.
- The project's component library or styling system (TailwindCSS, shadcn, MUI,
  plain CSS, or whatever already exists).
- A clear exported component name, such as `VariantA`, `VariantB`, `VariantC`.

Variants must be **structurally different** — different layout, different
information hierarchy, different primary affordance, not just different
colours. Three slightly tweaked card grids isn't a UI prototype, it's wallpaper.
If two drafts come out too similar, redo one with explicit "do not use a card
grid" guidance.

### 3. Wire them together

Create a single switcher component on the route:

```tsx
// pseudo-code — adapt to the project's framework
const variant = searchParams.get('variant') ?? 'A';
return (
  <>
    {variant === 'A' && <VariantA {...data} />}
    {variant === 'B' && <VariantB {...data} />}
    {variant === 'C' && <VariantC {...data} />}
    <PrototypeSwitcher variants={['A', 'B', 'C']} current={variant} />
  </>
);
```

For sub-shape A, keep the existing read-only data fetching above the switcher;
only the rendered subtree changes per variant. For sub-shape B, the throwaway
route under `/prototype/<name>` mounts the same switcher.

### 4. Build the floating switcher

A small fixed-position bar at the bottom-centre of the screen with three pieces:

- **Left arrow** — cycles to the previous variant and wraps around.
- **Variant label** — shows the current variant key and, if the variant exports
  a name, that name too, such as `B — Sidebar layout`.
- **Right arrow** — cycles forward and wraps around.

Behaviour:

- Clicking an arrow updates the URL search param using the framework's router,
  so the variant is shareable and reload-stable.
- Keyboard `←` and `→` keys also cycle. Don't intercept arrow keys when an
  `<input>`, `<textarea>`, or `[contenteditable]` is focused.
- Keep the bar visually distinct from the page so it is obviously not part of
  the design being evaluated.
- Gate the entire prototype on the repository's development-only convention, or
  an equivalent non-production check, so it cannot become a user-facing route
  or control.

Put the floating switcher in one prototype-local shared component so both
sub-shapes can reuse it. Do not promote it into production shared UI.

### 5. Hand it over

Surface the URL and the `?variant=` keys. The user will flip through whenever
they get to it. The interesting feedback is usually **"I want the header from B
with the sidebar from C"** — that's the actual design they want.

### 6. Capture the answer and clean up

Once a variant has won, record which variant won and why. Remove all variants,
the switcher, and any throwaway route, or leave them only in an explicit
prototype area. Do not create a branch or commit: Prototype creates no Git
action. Hand the answer to `$implement`; production delivery rewrites the chosen
design with normal tests, error handling, proof, and Review.

## Anti-patterns

- **Variants that differ only in colour or copy.** That's a tweak, not a
  prototype. Real variants disagree about structure.
- **Sharing too much code between variants.** A shared header is fine; a shared
  layout defeats the point. Each variant should be free to throw out the layout.
- **Wiring variants to real mutations.** Read-only prototypes are fine. If a
  variant needs to mutate, point it at a stub — the question is "what should
  this look like", not "does the backend work".
- **Promoting the prototype directly to production.** The variant code was
  written under prototype constraints. Implement owns the production version.
