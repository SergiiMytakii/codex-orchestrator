---
name: flutter-android-debug
description: Debug and verify Flutter UI on Android devices and emulators, including data-preserving updates of agent-launched debug builds. Always load and use `test-android-apps:android-emulator-qa` for adb-based QA. Use `flutter-attach-session` for live Flutter ownership discovery and safe reload or restart.
---

# Flutter Android Debug

Always load and use `test-android-apps:android-emulator-qa` in the same turn for
adb-based QA on Android devices and emulators. Use the selected serial for all
device commands.

Role split:

- `test-android-apps:android-emulator-qa` owns adb device selection, UI-tree
  navigation, input, screenshots, and logcat.
- `$flutter-attach-session` owns runtime discovery and reload/restart against a
  safely attachable standalone session.
- This skill owns the lifecycle authorization gate between them.

Use UI-tree coordinates for input. Enter the `cold-start` mode before using the
plugin's build/install/launch sequence.

## Reuse existing Android emulators

Before choosing a device, inspect `adb devices -l` and `emulator -list-avds`.
Reuse a suitable running emulator; otherwise select an existing AVD and start it
only when the task authorizes a launch. If several stopped AVDs fit, prefer the
newest installed Android version unless the task requires another version.
Do not create, clone, or provision an AVD, download a system image, or use
`avdmanager create avd`, `flutter emulators --create`, or equivalent tooling
unless the user explicitly requests creation of a new emulator. Task-specific
names, isolation, a clean installation, and QA requirements do not authorize a
new AVD. If existing devices cannot meet the requirement, report the concrete
mismatch and ask before provisioning. Preserve existing app/runtime ownership.


## Preserve the live session by default

Before any state-changing command:

1. Identify project, Android device serial, package, foreground activity, and expected
   environment.
2. Record the package PID.
3. Run Flutter discovery as JSON and inspect `selected.run.pid`,
   `selected.owner.type`, and `selected.owner.attach_safe`.
4. Choose `inspect-only`, `preserve-live`, or `cold-start` mode.

```bash
adb devices
adb -s <serial> shell pidof -s <package>
adb -s <serial> shell dumpsys activity activities | rg "mResumedActivity|topResumedActivity"
python3 "../../skills/flutter-attach-session/scripts/flutter_session_ctl.py" \
  discover --project /absolute/path/to/project --device-udid <serial> --json
```

Use the task's launch evidence to distinguish an agent-launched debug app from
a user-started one. The agent's own install/launch command output or recorded
handoff must identify this device and package and account for the current
process. A missing Flutter controller or VM Service alone proves nothing about
who launched the app. If the evidence is missing, stale, or contradicted,
preserve the current session.

## Mode contract

### `inspect-only`

Use for diagnosis or screenshots when interaction was not requested. Permit only
device/process inspection, UI-tree dump, screenshot, and log reads.

### `preserve-live`

Use when a package PID or Flutter runtime exists.

- Drive the existing process through the Android QA plugin.
- Use UI-tree-derived input and screenshot/logcat inspection; do not call the plugin's
  build/install/launch quick start and do not use `am start` to replace the current app.
- Check the same package PID after each non-trivial navigation action.
- Call `$flutter-attach-session` with the PID confirmed by discovery only for a
  safely attachable standalone session. For `ide_debug_adapter` or `machine_run`,
  never attach a second compiler/controller. Keep using Test Android Apps for
  inspection and in-app navigation. For a user-controlled runtime that needs a
  reload/restart, ask the user to use the owning controller. For an agent-launched
  runtime that cannot be updated safely in place through Flutter, use the
  `cold-start` gate below.

For a safely attachable standalone runtime:

```bash
python3 "../../skills/flutter-attach-session/scripts/flutter_session_ctl.py" \
  reload --project /absolute/path/to/project --device-udid <serial> --expected-pid <pid>
```

Use `restart` instead of `reload` only for startup, provider, route, DI, global, or
initialization changes.

### `cold-start`

Use during authorized implementation or QA when the task requires a refreshed
build and the agent's launch evidence establishes ownership of the current
debug app. Proceed without asking again if hot reload or hot restart is unavailable
or insufficient, including when the app is still running on Samsung after its
Mac-side Flutter controller has disconnected.

Also use this mode when the user requests a fresh run/install and there is no live
target, or explicitly authorizes replacing a verified user-started app outside the
IDE. Keep an IDE-owned app running and ask the user to refresh it through the IDE.

Before updating an agent-launched build, recheck the device and package ownership.
Resolve the exact flavor, build variant, package, activity, Flutter binary,
dart-defines, and backend from the project's launch configuration. Build the APK
and update the same package in place with `adb -s <serial> install -r <apk>`.
Require a successful data-preserving install before launching the resolved activity.
If Android rejects the update, report the install error. Never work around it by
uninstalling, clearing app data, or switching package IDs. Record the new PID,
verify the expected variant and backend, and continue the requested QA.

## Hard stops

- Inspection and screenshot-only requests use `inspect-only`. Replacement
  requires the `cold-start` gate, and its agent-owned exception covers only a
  data-preserving update and relaunch.
- Do not send `q` to a Flutter controller.
- Do not bypass `$flutter-attach-session` with a raw second attach client.
- Never pass an override flag to attach to an IDE/debug-adapter or machine-run owner.
- Do not activate, open, focus, or automate an IDE for reload/restart. IDE menus,
  Command Palette, keyboard shortcuts, `osascript`, System Events, and other GUI
  automation are forbidden. If the helper fails, report its error without an IDE
  fallback.
- If PID changes or disappears unexpectedly, stop live control and identify the
  preceding command. Recover only through the `cold-start` gate.
- If runtime selection changes between discovery and action, rediscover and obtain a
  new confirmed PID; never reuse the old authorization.

## Login gate

When auth blocks Levantem LOCAL/DEV QA, use `$levantem-login` for the
intended account, then resume after its login verification passes. For other
projects or unsupported modes, request manual login.

## Visual QA completion

Do not claim completion until:

- the original process remained alive, or the authorized cold-start is documented
- the expected variant/backend is confirmed
- the exact target screen and interaction state are reached using the Android plugin
- the final PID matches the preserved or newly launched session
- a final screenshot is captured and visually inspected
- relevant logcat evidence is checked when runtime behavior is involved
