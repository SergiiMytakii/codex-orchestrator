# Repository Notes

- `codex-orchestrator` is published by pushing the release commit to `main`; do not run `npm publish` manually unless the GitHub release workflow is unavailable.

## Release Notes Policy

When cutting a new release:

- Update `CHANGELOG.md` with human-readable “what got better” notes for the new version.
- Update the **Latest release** section below with a short functional summary (2–6 bullets).
- Run `npm run smoke:live` only when the user explicitly requests a live smoke run (it creates/updates GitHub issues and PRs).

### Latest release

- `0.1.24` (2026-05-14):
  - Android mobile UI proof now uses an explicit adb/emulator preflight instead
    of Playwright-first guidance.
  - Agents are told to prefer a connected Android device, then fall back to an
    emulator.
  - Missing Test Android Apps/plugin/device setup is reported as a warning, not
    a release blocker.
