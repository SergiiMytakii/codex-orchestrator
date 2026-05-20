# Issue Tracker: GitHub

Issues and PRDs for this repo live in GitHub Issues for
`SergiiMytakii/codex-orchestrator`.

## Conventions

Use the `gh` CLI for issue operations.

- Create an issue: `gh issue create --title "..." --body-file <path>`.
- Read an issue: `gh issue view <number> --comments`.
- List issues: `gh issue list --state open --json number,title,body,labels,comments`.
- Comment on an issue: `gh issue comment <number> --body "..."`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` /
  `--remove-label "..."`.
- Close an issue: `gh issue close <number> --comment "..."`.

Infer the repo from `git remote -v` when possible. Use
`SergiiMytakii/codex-orchestrator` explicitly when a command runs outside the
repo root.

## PRD Publication

When a skill says "publish to the issue tracker", create a GitHub Issue and add
the `needs-triage` label:

```sh
gh issue create --repo SergiiMytakii/codex-orchestrator \
  --title "..." \
  --label "needs-triage" \
  --body-file /path/to/body.md
```
