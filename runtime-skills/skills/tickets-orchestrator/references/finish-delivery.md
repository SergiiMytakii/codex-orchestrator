### 5. Finish

After all child issues are implemented:

1. Run final integration/regression issue(s) last.
2. Run a top-to-bottom reconciliation pass over all child issues: acceptance criteria, skipped checks, blockers, and out-of-scope protections.
3. For spec-gated work, run required cleanup and final ``code-review`` through the accepted spec's Implementation Review Loop in its scheduled order and remaining whole-spec budget. Do not create a second final review allowance.
4. For no-spec work, invoke ``cleanup-review`` and final ``code-review`` only when repo policy requires them.
5. Fix grounded findings in one consolidated batch and rerun relevant checks; use same-session Closure for spec-gated verification when the Module schedules it.
6. Summarize completed issues, verification, skipped checks, and follow-up risks.
7. For medium/high-risk parent work, prepare a final risk/proof mini-report before delivery. Keep it concise:
   - Parent contract implemented
   - Completed waves/issues
   - High-risk checkpoints and Review Focus status
   - Main invariants proved
   - Code-review findings and fixes
   - Validation passed
   - Skipped checks with reasons
   - Residual risks
   - Commits/PR state
   - For spec-gated work: implementation review profile, reviews used/budget, verified/open defect IDs, and outcome

### 6. Delivery

After orchestration is complete, handle the GitHub delivery routine unless the user asks to stop before delivery.

1. Confirm every completed child issue was already commented on and closed during its wave integration.
2. If any completed child issue is still open, close it now only after verifying it has implementation proof, commit reference, and a result comment.
3. Comment on the parent issue with the final package summary: completed children, verification, out-of-scope items preserved, and follow-up risks. For medium/high-risk work, include the final risk/proof mini-report in this parent comment.
4. Ensure completed child issues already have focused commits, or documented wave commits when safe separation was not possible.
5. Open a pull request for the parent issue when requested or when repo workflow expects PR-based delivery.
6. Stop and ask the user before any human-only action: PR approval, merge, product decision, manual validation that cannot be automated, or missing access/secrets.

Delivery prompt shorthand:

```text
After completing `tickets-orchestrator`, do delivery:
verify completed child issues were closed as each issue finished,
update the parent issue,
ensure focused commits exist and open a PR.
If any step needs a human decision, stop and ask.
```
