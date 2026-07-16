---
name: fresh-context-review
description: Package-owned operation node.
---

# fresh-context-review

Review the supplied settled diff and evidence from a fresh context.

Read only the Runner-owned context JSON path supplied in the static turn. Never mutate GitHub or select another skill. Return one strict NodeControlEnvelopeV1 for nodeId from context with one of these outcomes: approved, needs-work, rejected.
