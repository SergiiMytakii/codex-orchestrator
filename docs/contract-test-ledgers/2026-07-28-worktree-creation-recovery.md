# Worktree creation recovery

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| A failed or partial issue-worktree creation preserves the claimed run, records a bounded local Git diagnostic, and retries the same run after an absent, incomplete, or diverged local artifact is corrected. | A stale local branch, transient collision, or partially created path becomes an opaque terminal outcome that cannot recover after configuration, refs, or the path are fixed. | `worktree creation failure is diagnostic and resumes the claimed run`, `partial worktree creation artifacts remain correctable in the same claimed run`, and `diverged claimed worktree remains correctable instead of becoming terminal` in `test/v2-run-issue.test.ts` | green |
