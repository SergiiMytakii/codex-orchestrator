# Repository Notes

- `codex-orchestrator` is published by pushing the release commit to `main`; do not run `npm publish` manually unless the GitHub release workflow is unavailable.

## Release Notes Policy

When cutting a new release:

- Update `CHANGELOG.md` with human-readable “what got better” notes for the new version.
- Update the **Latest release** section below with a short functional summary (2–6 bullets).
- Run `npm run smoke:live` only when the user explicitly requests a live smoke run (it creates/updates GitHub issues and PRs).

### Latest release

- `0.1.27` (2026-05-18):
  - Package-bundled workflow prompts are documented as the runtime model, with
    no dependency on local Codex `SKILL.md` files.
  - `agent:auto` is reserved for standalone scoped issues.
  - Issue-tree children use `agent:child` plus runner metadata and are executed
    only by their parent `agent:plan-auto` flow.
  - Setup installs full bundled workflow prompts and preserves project-owned
    prompt edits by default.

- `0.1.26` (2026-05-16):
  - Read-only `doctor` diagnostics report runner readiness in text or JSON.
  - `status --json` exposes queue, recovery, active run, and recent event
    evidence for dashboards.
  - Phase-specific Codex profiles, lifecycle events, and context snapshots make
    runner sessions easier to audit without raw transcripts.
  - Live smoke covers diagnostics/profile behavior through the packaged CLI.

- `0.1.25` (2026-05-15):
  - Runner-owned Loop Policy adds priority-based daemon selection and bounded
    rework.
  - Fresh-Context Review and Durable Run Summary evidence can be included in
    scoped and issue-tree handoffs.
  - Policy Suggestions are reported as non-mutating recommendations.
  - Live smoke now validates the Loop Policy path end to end against GitHub.
