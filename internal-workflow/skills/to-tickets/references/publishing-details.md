# To Tickets Publishing Details

## Executable ticket body

Every ticket is executable from its body plus the Parent PRD without another
planning artifact. Keep the body local and include only:

- the Parent link;
- the local observable outcome and acceptance criteria;
- in-scope and out-of-scope boundaries;
- confirmed owner/public seam when needed for zero-guess execution;
- blockers and native dependency links;
- behavior proof or exact non-TDD proof;
- AFK/HITL final state, which never authorizes implementation.

Do not copy the Parent's product authority into each ticket. Keep shared product
rules in the Parent, make a contract-owning ticket block its consumers, and
merge slices that cannot stand or be proved independently. A material execution
gap becomes a blocking discovery/HITL ticket or a Decision Delta; never defer it
to a later planning artifact.

## Publish template

For local files, prefix the body with `# <NN> — <Ticket title>`. For a real
tracker, use the same title as the issue title and begin the body at `## Parent`.
The body shape is otherwise identical:

```md
## Parent

<authoritative Parent link>

## Observable outcome

<one end-to-end behavior>

## Scope

- In scope: <local behavior and owner>
- Out of scope: <source-authorized boundary>

## Acceptance criteria

- [ ] <observable criterion>
- [ ] <observable criterion>

## Owner and proof seam

- Owner / public seam: <confirmed owner or bounded discovery>
- Proof: <behavior-level or exact non-TDD proof>
- Why false behavior cannot pass: <short explanation>

## Blocked by

<native ticket relationships or None>

## Final state

AFK: `ready-for-agent`; HITL: `ready-for-human`. State does not authorize
implementation.
```

## Serialized publication

The single current root publisher performs every tracker effect. Do not create
a claim, lease, lock service, coordinator record, or other durable publication
state.

Before writing:

1. Search for an existing source-linked Parent and source-linked children.
2. Reconcile immutable source identity and any known tracker identities.
3. If concurrent publication cannot be excluded, multiple matching Parents
   exist, or a partial packet cannot be identified deterministically, perform no
   writes and fail closed.

Publish in dependency order and await each create, link, and label effect
separately, then reread authoritative tracker state before the next write.
Persist each returned identity through the Parent/source links in issue bodies.
Apply labels only after identity reconciliation.

Publication records the graph frontier but never works it. A ticket with no
unresolved blockers is merely eligible for later separately authorized
delivery; publication does not start that delivery.

After a timeout, transport loss, or unknown write outcome, reread the tracker
and retry only a proven-missing effect. Continue an identifiable partial packet
by filling missing issues or relationships; never recreate an identifiable
issue and never retry an unknown effect blindly.

## Authoritative read-back

After every publication effect, reread the tracker and compare it with the
approved packet. Verify:

- exact approved Parent and ticket bodies after substituting only approved
  tracker identifiers, native links, and final state;
- native Parent, sub-issue, and blocker links in both directions where the
  tracker exposes them;
- exact AFK/HITL labels and absence of conflicting planning or delivery state;
- absence of duplicate or partial packets;
- every ticket remains executable from its body plus the Parent PRD;
- the publication event trace contains one semantic review, one approval, and
  no implementation action.

Post-publication read-back is integrity proof. It does not launch another
semantic reviewer and does not request another approval.

A proven technical mismatch such as a missing label or native link may be
repaired deterministically and reread. Ambiguous identity, concurrent writes,
or duplicate candidates fail closed without writes. A repair that changes
behavior, scope, ownership, ticket boundaries, blockers, or proof obligations
is a Decision Delta: invalidate approval, rebuild the complete packet, run one
new fresh semantic review, and obtain one new explicit user approval.

Successful read-back must stop before implementation. Publication, links, and
labels do not authorize delivery.
