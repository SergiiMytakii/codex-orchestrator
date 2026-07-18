# Cleanup Lens

Use this method inside the code-review spec/standards lens. Its job is to reduce
maintenance surface without changing required observable behavior. It is never
a standalone gate, activation, verdict, or coverage class.

## Depth

- **Bounded:** inspect material additions and replacements for obvious duplicate
  owners, obsolete paths, workaround branches, dead code, and unjustified
  abstractions.
- **Amplified:** when mandatory Review Focus names a concrete evidenced
  simplification risk, inventory every material addition, replacement,
  compatibility path, and runtime owner related to that risk. Do not amplify
  from file count, implementation size, or review profile alone.

## In Scope

- duplicated logic, sources of truth, registrations, or old/new paths kept in parallel
- dead helpers, flags, adapters, branches, comments, tests, or documentation left by the change
- workaround-shaped conditionals, magic ordering, symptom patches, and unnecessary state
- compatibility or fallback behavior without current repository, source-authority, or production evidence
- new services, events/listeners, adapters, or indirection with one current consumer and only speculative reuse
- ownership placement when moving or deleting code restores an existing owner without redesigning the system

Do not turn functional correctness, security, performance, product decisions,
missing regression proof, broad architecture redesign, or style preferences
into cleanup findings. Route them to the applicable code-review lens.

## Method

Classify each material complexity decision:

- `KEEP`: a current invariant requires it and evidence or a boundary proof supports it.
- `SIMPLIFY`: required behavior can use a smaller existing seam or fewer states or branches.
- `REMOVE`: no current behavior, authority, consumer, or compatibility evidence requires it.

A one-producer/one-consumer abstraction defaults to `SIMPLIFY` unless a concrete
lifecycle, transaction, dependency-direction, or fanout invariant requires the
boundary. Do not request a new abstraction unless it reduces current
duplication or restores an existing owner now.

Report a finding only with exact evidence, concrete maintenance cost, and a
behavior-preserving fix. Uncertain removal is a non-blocking follow-up. In
amplified mode, include concise `KEEP | SIMPLIFY | REMOVE` decisions in the
spec/standards handoff; bounded mode needs decisions only when they explain a
finding or protected invariant.

Cleanup repairs retain the same defect IDs. Medium or low cleanup repairs use coordinator verification plus affected validation. Launch affected-lens Closure
only when the shared review protocol requires it for severity, protected
contract impact, or invalidated mandatory coverage; add correctness whenever
that Closure repair may alter observable behavior.
