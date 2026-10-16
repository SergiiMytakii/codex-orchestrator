---
name: flutter-android-debug
description: Safely debug Flutter UI on Android emulators while preserving existing app/IDE sessions. Always load and use `test-android-apps:android-emulator-qa` in the same turn for device selection, navigation, UI trees, screenshots, and logcat. Use for visual verification, reproduction, and authorized reload/restart coordination; pair with `flutter-attach-session` when a live Flutter runtime must be discovered or controlled.
---

# Flutter Android Debug

Use this tracked skill as the Android Flutter orchestrator. In the same turn, always
load and use `test-android-apps:android-emulator-qa` for the actual emulator QA
commands. Do not proceed with Android UI work if that plugin skill was not loaded.

Role split:

- `test-android-apps:android-emulator-qa` owns adb device selection, UI-tree
  navigation, input, screenshots, and logcat.
- `$flutter-attach-session` owns runtime discovery and reload/restart against a
  safely attachable standalone session.
- This skill owns the lifecycle authorization gate between them.

The Test Android Apps skill is mandatory for emulator QA. Use its documented adb/UI-tree
surface for device selection, navigation, input, screenshots, and logcat; do not replace
it with guessed coordinates or an unrelated shell workflow. Its quick-start
build/install/launch sequence is a `cold-start` recipe only, not a default for a live
Flutter session.

## Preserve the live session by default

Before any state-changing command:

1. Identify project, emulator serial, package, foreground activity, and expected
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

Any live app PID, VM Service, IDE debug adapter, `flutter run`, or visible app is
user-owned state. A booted emulator alone is not a live app session.

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
  inspection and in-app navigation; if reload/restart is necessary, ask the user to
  trigger it through the owning controller and continue after confirmation:

```bash
python3 "../../skills/flutter-attach-session/scripts/flutter_session_ctl.py" \
  reload --project /absolute/path/to/project --device-udid <serial> --expected-pid <pid>
```

Use `restart` instead of `reload` only for startup, provider, route, DI, global, or
initialization changes.

### `cold-start`

Use only when no live target exists and the user requested a fresh run/install, or
after explicit permission to replace the current session.

Before launch, resolve the exact flavor, build variant, package, activity, Flutter
binary, dart-defines, and backend. Then follow the plugin's build/install/launch flow.

## Hard stops

- A request to debug, inspect, navigate, screenshot, or verify UI does not authorize
  install, uninstall, clear data, force-stop, kill, replacement launch, or a new
  `flutter run`.
- Do not execute the plugin's build/install quick start while in `preserve-live` mode.
- Do not send `q` to a Flutter controller.
- Do not bypass `$flutter-attach-session` with a raw second attach client.
- Never pass an override flag to attach to an IDE/debug-adapter or machine-run owner.
- Do not activate, open, focus, or automate an IDE for reload/restart. IDE menus,
  Command Palette, keyboard shortcuts, `osascript`, System Events, and other GUI
  automation are forbidden. If the helper fails, report its error without an IDE
  fallback.
- If PID changes or disappears, stop and identify the preceding command. Do not launch
  the installed APK and do not claim that hot reload can restore the process.
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
- the final PID matches the preserved session
- a final screenshot is captured and visually inspected
- relevant logcat evidence is checked when runtime behavior is involved
