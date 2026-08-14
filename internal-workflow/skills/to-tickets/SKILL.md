---
name: to-tickets
description: Compile Plan's contextual PRD draft or approved product authority into the smallest executable ticket packet, run fresh semantic review per settled revision, obtain one approval, publish serially, verify tracker read-back, and stop before implementation.
---

# To Tickets

Compile product authority into the smallest number of independently verifiable
vertical tickets. Keep one coherent outcome as one ticket. Each generated AFK
ticket must be executable from its body plus the Parent PRD and current
repository evidence without another planning artifact.

The Parent PRD remains the sole product and final-acceptance authority. Each
ticket contains only its local observable outcome, scope, blockers, proof, and
Parent link. The approved ticket body plus Parent PRD is the final execution
authority; no later planning pass is inserted.

`$to-tickets` owns one fresh reviewer per settled revision, one explicit user
approval, serialized publication, reconciliation, and tracker read-back.

The primary route remains `planning-only` while compiling or publishing these
artifacts. `ticket-graph` begins only after separate delivery authorization;
never report it merely because the planning output is a graph.

Read the repository's issue-tracker policy and triage vocabulary before
preparing publication. If either required authority is missing, stop before
tracker effects and ask the user; do not invent a tracker, schema, or labels.

## Progressive Reference

Read [publishing-details.md](references/publishing-details.md) before preparing
the complete publish-ready packet, requesting approval, or publishing any
tracker effect.

## Shape

Split only for an independent outcome, owner, release, real blocker, safe
parallel boundary, or human/live gate. Do not split by technical layer.

Each ticket is a tracer-bullet vertical slice: it cuts a narrow but COMPLETE
path through every relevant layer, is demoable or verifiable on its own, and is
sized to fit in a single fresh context window. Keep one coherent outcome as one
ticket. Add discovery, integration, or HITL tickets only when each has its own
outcome and blocking relationship. Risk strengthens proof and review focus; it
does not create tickets. Merge steps that share one owner, release, and
validation path.

Do not publish a child whose outcome is only transient evidence or a tracker
comment. Resolve that discovery before compiling the executable graph, or make
the required durable result a committed artifact.

Where repository evidence proves a small prefactor is required, "Make the
change easy, then make the easy change." Keep it inside the same vertical
outcome unless it is independently verifiable and genuinely blocks later work.
File size or general cleanliness alone does not justify prefactoring.

## Process

### 1. Gather authority

Read the complete source and its decision-changing comments. Reuse cited
`$research` artifacts. If a material external contract remains unresolved,
create a blocking discovery ticket.

Explore only enough repository code, tests, ADRs, and domain docs to identify
the real owner/public seam and a compatible proof. Never invent paths, symbols,
commands, fixtures, ownership, or behavior.

When an applicable owner/public seam is honestly unknown, create a blocking
discovery ticket whose observable outcome is the missing owner, seam, and proof
evidence. Do not publish the dependent implementation ticket as AFK-ready until
that discovery resolves it.

### 2. Draft executable vertical tickets

Apply this **Minimum solution check** before drafting:

- state the direct solution through existing owners and seams;
- add no new service, adapter, middleware, wrapper, compatibility path, or
  custom verifier by default;
- add a new mechanism only for a confirmed obligation or proven failure path
  that the direct solution cannot satisfy;
- perform a deletion challenge: remove any proposed mechanism that can be
  deleted without losing required behavior, an invariant, or credible proof.

Each ticket must:

- deliver one observable end-to-end outcome;
- link directly to its Parent PRD;
- bound local scope and out-of-scope work;
- name the owner/public seam when repository evidence confirms it;
- state observable acceptance criteria and a compatible behavior proof or exact
  non-TDD proof;
- explain why the proof cannot pass while the approved claim is false;
- declare real blockers and dependency edges.

Illustrative tuning values remain illustrative unless product authority makes
them exact. Acceptance criteria describe observable outcomes. Freeze an
internal mechanism only when a public contract, ownership boundary, safety
requirement, or inter-ticket dependency depends on it.

Add `Binding implementation decisions` only when two locally valid
implementations could conflict at a ticket edge, public contract,
identity/cardinality, persisted or in-flight state, concurrency, shared
behavior, or Parent proof. Record only confirmed boundary semantics; leave
private structure to Implement. Omit the section when Parent and existing seams
already determine the behavior. Return an unconfirmed product choice as a
Decision Delta and missing technical evidence as blocking discovery.

Keep unresolved product decisions with the user and unresolved external or
technical discovery in a blocking AFK/HITL ticket. If the generated ticket
would need a later planning artifact, it is not ready to publish.

For user-facing work, include an end-to-end walkthrough criterion and use
`$ui-evidence-proof` as the proof standard. For a wide mechanical refactor, use
expand-contract and keep each migration batch independently green.

If repository evidence proves an **indivisible migration** whose intermediate
batches cannot be independently green, do not publish those batches as child
tickets and do not create a shared red integration branch. Compile one
executable migration ticket with one owner, one isolated execution scope, and
one final green acceptance boundary over the complete migrated state. In this
fallback, intermediate batches are not child checkpoints and release no successor. If
that complete outcome cannot fit one fresh implementation context or lacks a
credible final proof, return a Decision Delta instead of publishing an
unexecutable graph.

### 3. Freeze the complete publish-ready packet

Keep one contextual packet containing the complete Parent PRD and every exact
ticket body, plus:

- source solution, scope, exclusions, decisions, and consequences;
- ordered graph and blocking edges;
- material risks and open questions.

This packet is contextual planning data, not a separately published artifact or
workflow owner. Do not publish any intermediate PRD.

### 4. Run one fresh semantic packet review

For each settled revision, launch exactly one fresh `standards_reviewer`
without history (`fork_context=false` on V1; `fork_turns="none"` on V2). Begin
with `Assigned role: standards_reviewer`, provide the full authority and packet,
and apply all three lenses in the same activation: source fidelity, ticket
executability, and minimum solution and scope conservation.

- **Source fidelity:** every product claim, decision, scope boundary,
  consequence, and blocker is grounded in the source; no behavior or ownership
  is invented or lost.
- **Ticket executability:** every ticket is a cohesive vertical outcome that a
  fresh implementation context can execute and prove from its body plus the
  Parent PRD; dependencies are real, proof observes the claim, and no later
  planning artifact is required. Ask whether the implementer can execute it
  without independently choosing product behavior or incompatible system
  semantics; require confirmed binding decisions only when the answer is no.
- **Minimum solution and scope conservation:** reject Speculative Generality,
  Middle Man indirection, unsupported new or duplicate owners, proof-only
  runtime machinery, acceptance criteria without Parent/user/repository
  authority, and prefactors that can stay inside the real vertical outcome.
  Prefer deletion or narrowing before adding machinery. The reviewer may not
  introduce a new runtime mechanism merely to make proof more exhaustive.

Before verdict, traverse each applicable seam:

- Parent obligation to owning ticket and proof;
- producer and consumer across each edge: data, identity/cardinality, state,
  timing, and failure semantics;
- changed persistence or namespace to existing and in-flight state;
- reused behavior to equal semantics or an explicit delta;
- UI promise to its API or DTO source;
- child-added choice to Parent, user, or repository authority.

Return concise evidence for applicable seams and omit `N/A` seams. This is
review output, not another packet artifact.

The reviewer is read-only and returns `APPROVE` or `NEEDS_WORK` with exact
source/artifact evidence. Capture a non-empty fresh child identity and wait for
that same child. Do not split the lenses across children and do not launch the
delivery Standards review. After `NEEDS_WORK`, repair the packet and launch a
new reviewer without prior review history over the complete revised packet. A
same-context or findings-only recheck cannot approve. Repeat until the latest
revision receives one full approval. Missing or failed review blocks
publication; product-changing repairs return to the user.

### 5. Get one explicit approval

After the semantic review approves, show the complete publish-ready packet and
obtain one explicit user approval of the exact Parent and ticket bodies, product
decisions, scope, exclusions, ticket boundaries, blockers/dependencies,
ownership, HITL/live gates, and proof obligations. Tracker identifiers, native
links, and final state are the only fields publication may fill afterward.

The single exact-packet approval also answers Matt's useful breakdown checks:

- Does the granularity feel right?
- Are the blocking edges correct — does each ticket only depend on tickets that
  genuinely gate it?
- Should any tickets be merged or split further?

These are not separate quizzes or approvals. Any requested change rebuilds the
complete packet under the Decision Delta rule below.

A change to behavior, scope, ownership, ticket boundaries, blockers, or proof
obligations invalidates approval and returns a Decision Delta. The changed
complete packet requires one new fresh semantic review and one new explicit
user approval before publication can continue.

### 6. Publish final artifacts

Follow [publishing-details.md](references/publishing-details.md). Publication is
serialized through the single current root publisher. If product context is
not durable, first publish one non-executable Parent marked
`Artifact: planning-context` and without a triage state. When a source tracker
issue already exists, reference it without closing or relabeling it. Publish
blockers first.

- **Local files:** write one file per ticket under
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`.
- **Real tracker:** publish one issue per ticket in dependency order and use
  native Parent/sub-issue and blocking links.

Record the future frontier — tickets whose blockers are all done — in the
approved graph, but do not work it. Delivery starts only under separate
authorization after this planning flow stops.

The issue body plus Parent PRD is the durable execution authority. Apply
`ready-for-agent` to AFK and `ready-for-human` to HITL tickets directly; do not
invoke `$triage` or add a duplicate brief comment. Publish the approved terms
unchanged except for tracker identifiers, native links, and final state.

Reject AFK publication when criteria require later interpretation, proof can
pass while the claim is false, an applicable owner/seam is unknown, or a future
planning artifact is required. After all publication effects, perform the
authoritative tracker read-back and deterministic reconciliation defined in the
reference.

Successful read-back stops planning before implementation. Publication, links,
and labels do not authorize delivery.
