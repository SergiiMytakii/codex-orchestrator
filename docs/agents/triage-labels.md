# Runner labels

These are the current labels owned by the package lifecycle. They are distinct
from external planning or issue-triage vocabulary.

| Label | Meaning |
| --- | --- |
| `agent:auto` | Explicit authority to execute this open Issue. |
| `agent:running` | The Runner currently owns the bounded invocation. |
| `agent:blocked` | The Issue stopped at an authority, proof, external, preservation, or safety boundary. |
| `agent:review` | The draft PR passed applicable checks, proof, and Review and is ready for human review. |

Only `agent:auto` grants delivery authority. Planning context, Parent links,
comments, and other triage labels do not. GitHub mutations remain subject to
the boundary in `docs/agents/issue-tracker.md`.
