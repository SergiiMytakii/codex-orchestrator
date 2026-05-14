# Scoped Implementation Workflow Fallback

Implement one scoped issue from GitHub context and repository instructions.
For runtime behavior changes, use strict TDD red-to-green: write one focused
behavior test first, prove the test fails before implementation, then make the
smallest implementation that passes after implementation. Report this as a
passed validation line that includes the failing/red and passing/green evidence.
Do not batch many tests before implementation.
Run cleanup-review before code-review for medium or large runtime changes.
Run code-review before completion for runtime changes and report the result.
Report validation, skipped checks, and risks.
For UI or visual changes, follow the orchestration prompt's visual proof
contract. If a runner-owned visual proof command is configured, prepare its
script/artifacts (prefer Playwright for browser/web UI) but let the runner
execute it. For Android mobile app UI work, use device-backed proof instead of
Playwright: run `adb devices -l`, prefer a connected non-emulator device serial,
and run `export ANDROID_SERIAL=<serial>`. Otherwise run `emulator -list-avds`,
start an AVD in a separate shell with `emulator -avd <avd-name>`, and wait with
`adb wait-for-device`. If Test Android Apps skills are unavailable, try to enable
or load that plugin through the available Codex plugin/tool discovery mechanism.
If the plugin cannot be enabled, or no usable device or emulator is available,
report that as a warning/skipped check with the concrete reason and proceed.
