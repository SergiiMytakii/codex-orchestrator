---
name: flutter-ios-debug
description: Debug and validate Flutter UI on iOS Simulator while preserving IDE-owned sessions. Use for visual checks, navigation/input, screenshots, expected-vs-actual comparison, and authorized cold-start recovery.
---

# Flutter iOS Debug

Use this skill as the platform QA layer for Flutter on iOS Simulator. It owns
environment checks, navigation, interaction, screenshots, and visual evidence. It
does not automatically own an existing app process or IDE incremental compiler.

## Non-negotiable runtime invariant

Treat any live `Runner`, Flutter VM Service, `flutter run`, IDE debug adapter, or
visible simulator app as user-owned state.

- Preserve the process and its DevFS state.
- Do not start a duplicate `flutter run`.
- Do not terminate, relaunch, reinstall, or replace a live session without explicit
  user authorization.
- Never attach a second Flutter compiler/controller to an IDE-owned or machine-run
  session; preserve it and ask the user to use the owning controller when reload or
  restart is necessary.
- Never activate, open, focus, or automate an IDE for reload/restart, or other GUI
  automation.
- Never send `q`; it terminates the application. Use `Ctrl+C` only to detach a client
  that this agent safely attached itself.
- If the process disappears, stop. Hot reload cannot resurrect it; report the lost
  session instead of silently launching an older installed build.

## Select the operating mode first

Before any state-changing command, inspect the simulator and runtime:

```bash
xcrun simctl list devices | rg Booted
ps aux | rg "Runner.app/Runner|flutter_tools.snapshot run --machine" -S
python3 "../../skills/flutter-attach-session/scripts/flutter_session_ctl.py" \
  discover --project /absolute/path/to/flutter-project
```

Choose exactly one mode:

1. `inspect-only`
   - Use for diagnosis, screenshots, environment inspection, and logs when the user
     has not asked for interaction.
2. `preserve-live`
   - Use when a `Runner` PID or Flutter session already exists.
   - Keep the same process and drive only the requested in-app flow.
3. `cold-start`
   - Use only when no live app exists and the user requested a fresh run, or after
     the user explicitly approves replacing the current session.

A booted simulator without a matching `Runner` is not a live app session. A matching
live process is enough to block automatic relaunch even if VM discovery is ambiguous.

## Command safety classes

### Read-only inspection

Allowed in `inspect-only` and `preserve-live`:

- simulator/device listing
- process and VM Service discovery
- screenshots
- logs and environment indicators

### In-app state changes

Allowed only when the requested QA flow requires interaction:

- deep-link navigation with `simctl openurl`
- Dart tooling / `flutter_driver` taps, text entry, scrolling, and waits
- calibrated macOS coordinate input as a last resort

Record the `Runner` PID before the first interaction and check it after every
non-trivial navigation step. If it changes or disappears, stop and report the exact
preceding action.

### Lifecycle-destructive commands

Allowed only in `cold-start` mode:

- `simctl terminate` or `launch`
- killing a Flutter machine run or `Runner`
- starting `run_flutter_ios_debug.py` or a new `flutter run`
- reinstalling or replacing the app

Do not infer permission for these actions from a request to debug, inspect, navigate,
take a screenshot, or verify a code change.

## Runtime ownership and reload path

Use `$flutter-attach-session` as the runtime transport companion, not as the UI QA
workflow.

- If discovery reports `owner.type=ide_debug_adapter` or `owner.type=machine_run`,
  do not attach. Continue inspection/navigation without runtime control; when a reload
  or restart is necessary, ask the user to trigger it through the owning controller.
- For a standalone VM Service, use `$flutter-attach-session` without the opt-in flag.
- Use `r` for widget, layout, style, and rendering changes.
- Use `R` for routes, providers, dependency injection, globals, initialization, or
  constructor changes that reload cannot apply safely.
- After reload/restart, re-check PID, environment, and visible route before navigating.

An attach or reload success message is not UI proof. Always reach and capture the
requested state.

## Environment gate

Before and after reload/restart:

1. Inspect the live `flutter run` arguments, including `--dart-define BASE_URL=...`.
2. Match the process to the booted simulator and project.
3. Confirm the visible in-app environment badge or startup log.
4. Require process arguments and the visible indicator to agree.
5. If the live environment is wrong, report the mismatch and obtain authorization
   before replacing the session.

Load environment indicators and expected backend values from the owning repository.
Do not continue QA when process arguments and the visible environment disagree.

## Preserve-live visual QA loop

1. Record simulator, project, `Runner` PID, runtime owner, route, and environment.
2. Capture a baseline screenshot when the current state matters.
3. Apply reload/restart through the safe owner path when code changed.
4. Re-confirm PID and environment.
5. Navigate to the exact affected screen.
6. Trigger the exact interaction state under test.
7. Capture a final screenshot.
8. Visually inspect or compare it with the expected image.
9. Check the PID once more before claiming success.

If the screenshot is wrong, verify route and environment first, then decide whether
another owner-controlled reload/restart is necessary. Do not relaunch merely because
the first screenshot differs.

## Navigation strategy

Use the fastest reliable surface in this order:

1. Existing route/deep link
2. Stable widget selector (`ByValueKey` preferred)
3. Text selector
4. Calibrated macOS input
5. One manual user action when auth or tooling genuinely blocks automation

For a control, dialog, sheet, tab, or interaction bug, opening only the parent screen
is insufficient. Reach and capture the exact resulting state.

### Route navigation

Use a route declared by the owning application:

```bash
xcrun simctl openurl booted "<app-scheme>://<target-route>"
```

Verify the `Runner` PID after each deep link. Continue with widget interaction when a
deep link reaches only a parent route.

### Widget-driver navigation

Use Dart tooling / `flutter_driver` with this sequence:

1. `waitFor` or `waitForTappable`
2. `scroll_into_view` when needed
3. `tap`
4. `enter_text` when needed
5. `waitFor` the resulting state

Prefer stable `ByValueKey` selectors over text. Do not guess coordinates while a
stable selector exists.

### Coordinate fallback

When route and widget tooling cannot perform the gesture:

1. Activate Simulator.
2. Read the front window position and size.
3. Perform one calibrated gesture.
4. Capture a screenshot immediately.
5. Adjust only from screenshot evidence.

Capture after every non-trivial coordinate gesture until the path is proven stable.

## Login gate

When auth blocks Levantem LOCAL/DEV QA, use `$levantem-login` for the intended
account, then resume after its login verification passes. For other projects or
unsupported modes, use manual login:

1. Stop at the login screen.
2. Ask the user to log in manually.
3. Wait for explicit confirmation.
4. Resume navigation and capture the final screenshot yourself.

Do not perform UI automation before this confirmation when manual login is required.

## Authorized cold-start workflow

Enter this workflow only in `cold-start` mode. Resolve the exact device, flavor,
backend, and defines first.

```bash
python3 "../../skills/flutter-ios-debug/scripts/run_flutter_ios_debug.py" \
  --project /absolute/path/to/flutter-project
```

The script's login wait remains mandatory unless the task explicitly establishes that
login is unnecessary. After launch, confirm startup logs and the visible environment
indicator before navigation.

## Recovery rules

- Wrong route: recover with a deep link, then widget navigation.
- Restart returned to splash/root/login: navigate back to the target; do not stop at
  the restart message.
- Missing selector: try one justified scroll and re-query before manual fallback.
- Environment mismatch or multiple ambiguous VM Services: stop and report the
  ambiguity. Do not kill processes automatically.
- A clean relaunch is allowed only when the user already requested it or explicitly
  approves it after the mismatch is explained.
- Runtime error on the target screen: fix or report it before claiming completion.
- Unrelated warning elsewhere: record it and continue if it does not block the target.

## Screenshot and comparison

Capture the exact final state:

```bash
bash "../../skills/flutter-ios-debug/scripts/capture_ios_screenshot.sh" \
  /tmp/ios-actual.png <selected-simulator-udid>
```

Compare when an expected image exists:

```bash
python3 "../../skills/flutter-ios-debug/scripts/compare_ios_screenshots.py" \
  --expected /absolute/path/to/expected.png \
  --actual /tmp/ios-actual.png \
  --diff-out /tmp/ios-diff.png \
  --rmse-threshold 0.03
```

If no expected image exists, visually inspect the screenshot against the user's stated
result. Never infer UI success from command output alone.

## Completion criteria

Do not consider iOS UI work verified until:

- the original live process was preserved, or an authorized cold-start was documented
- the changed scope analyzes cleanly, or residual issues are identified as pre-existing
- the expected backend/environment was confirmed
- reload/restart used the safe runtime owner path when required
- the exact target screen and interaction state were reached
- the `Runner` PID stayed stable during preserve-live QA
- a final screenshot was captured and visually checked
