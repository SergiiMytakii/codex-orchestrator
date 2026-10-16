---
name: flutter-attach-session
description: Discover Flutter runtime ownership and control only safely attachable standalone sessions. IDE/debug-adapter and machine-run sessions are inspection-only and must never receive a second Flutter controller. For every Android emulator task, always load and use `test-android-apps:android-emulator-qa`, including screenshot-only work.
---

# Flutter Attach Session

Use this skill when the user wants work against an already running Flutter debug session.
If the target is Android, always load and use `test-android-apps:android-emulator-qa`
in the same turn. Mentioning attach, reload, restart, or an existing Flutter session does
not make this skill a substitute for the Android QA plugin.

This is a runtime transport skill, not a complete UI QA workflow:

- On Android, use `$flutter-android-debug` as the lifecycle orchestrator and
  `test-android-apps:android-emulator-qa` for navigation, taps, UI-tree inspection,
  screenshots, and logcat.
- On iOS Simulator, use `$flutter-ios-debug` for environment gates, navigation,
  interaction, screenshots, and visual comparison.
- Use this skill only to discover runtime ownership and control the selected live process.

Do not start a new `flutter run` unless the user explicitly asks for that. The default job is:

1. discover a live Flutter debug session
2. classify its runtime owner
3. pin the selected runtime PID
4. attach only to safely attachable standalone sessions and send `r`/`R` as needed

## Runtime ownership gate

Before `attach`, `reload`, or `restart`, inspect the discovery result and classify the
owner:

- `owner.type=ide_debug_adapter` or `owner.type=machine_run`: never attach a second
  compiler/controller. Preserve the runtime, use the platform QA skill for inspection
  and navigation, and ask the user to trigger `r`/`R` through the owning controller
  when reload/restart is necessary.
- safely attachable standalone VM Service: attach and send `r`/`R` normally.
- missing or ambiguous VM Service: stop and report the blocker. Do not guess a URI,
  start a replacement app, or fall back to the installed APK.

Record the app PID before runtime control and check it after reload/restart. If the PID
disappears or changes unexpectedly, stop. Hot reload cannot restore a dead process.
Never describe a cold relaunch as hot reload.

## Quick Start

Run `discover` first. Control commands are valid only for safely attachable standalone
sessions:

```bash
python3 "../../skills/flutter-attach-session/scripts/flutter_session_ctl.py" discover --json
python3 "../../skills/flutter-attach-session/scripts/flutter_session_ctl.py" attach --expected-pid <confirmed-pid>
python3 "../../skills/flutter-attach-session/scripts/flutter_session_ctl.py" reload --expected-pid <confirmed-pid>
python3 "../../skills/flutter-attach-session/scripts/flutter_session_ctl.py" restart --expected-pid <confirmed-pid>
```

If `flutter` is not on `PATH`, pass the binary explicitly or set `FLUTTER_BIN`.
`--flutter` and `--flutter-bin` are equivalent:

```bash
python3 "../../skills/flutter-attach-session/scripts/flutter_session_ctl.py" \
  reload \
  --project /absolute/path/to/flutter-project \
  --device-udid emulator-5554 \
  --expected-pid <confirmed-pid> \
  --flutter "$HOME/fvm/versions/3.44.3/bin/flutter"
```

When `--flutter-bin` is omitted, the helper resolves Flutter in this order:

1. `FLUTTER_BIN`
2. project `.fvm/flutter_sdk/bin/flutter`
3. project `.fvmrc` or `.fvm/fvm_config.json` mapped through `~/fvm/versions`
4. `flutter` from `PATH`
5. newest executable under `~/fvm/versions/*/bin/flutter`

Use the bundled discovery script directly when you need raw JSON or want to inspect the selected candidate:

```bash
python3 "../../skills/flutter-attach-session/scripts/discover_flutter_attach.py" --json
```

If the project is known, filter by it:

```bash
python3 "../../skills/flutter-attach-session/scripts/discover_flutter_attach.py" \
  --project /absolute/path/to/flutter-project \
  --json
```

If the target device is known, filter by simulator UDID or device name:

```bash
python3 "../../skills/flutter-attach-session/scripts/discover_flutter_attach.py" \
  --device-udid 0E8A75FE-FAC8-4C3E-8DAE-F665E724729E \
  --json
```

The discovery script prints the best candidate and an attach command for inspection.
Do not execute the raw attach command; use the control helper with
`--expected-pid selected.run.pid` so ownership and runtime identity are enforced.
The generated attach command must include the selected run's effective `--target`
and every original `--dart-define` / `--dart-define-from-file`. If discovery cannot
reconstruct that compile identity, the helper must refuse attach/reload/restart; do
not bypass it, because a hot restart can otherwise compile the default entrypoint or
fall back to production environment values.
The helper reads the original process argv so define values containing whitespace keep
their boundaries. Human-facing command output redacts define values and define-file
paths; never print or copy the raw executable command into commentary or reports.
The helper script wraps that discovery step and then either:

- opens an interactive `flutter attach`
- performs a one-shot `hot reload`
- performs a one-shot `hot restart`

## Attach Workflow

Use this workflow only for safely attachable standalone sessions. IDE/debug-adapter
and machine-run owners stop at discovery; use platform QA without runtime control.

Preferred commands:

1. interactive attach:

```bash
python3 "../../skills/flutter-attach-session/scripts/flutter_session_ctl.py" \
  attach \
  --project /absolute/path/to/flutter-project \
  --expected-pid <confirmed-pid>
```

2. one-shot hot reload:

```bash
python3 "../../skills/flutter-attach-session/scripts/flutter_session_ctl.py" \
  reload \
  --project /absolute/path/to/flutter-project \
  --expected-pid <confirmed-pid>
```

3. one-shot hot restart:

```bash
python3 "../../skills/flutter-attach-session/scripts/flutter_session_ctl.py" \
  restart \
  --project /absolute/path/to/flutter-project \
  --expected-pid <confirmed-pid>
```

If you need interactive control after discovery:

1. Run the helper's `attach --expected-pid <confirmed-pid>` command with a TTY.
2. Keep that session open.
3. Use terminal input:
   - `r` for hot reload
   - `R` for hot restart
   - `h` for help

Important:

- The bundled `flutter_session_ctl.py` helper is the only allowed reload/restart
  transport. Never activate, open, focus, or automate an IDE. Never invoke IDE menus,
  Command Palette, keyboard shortcuts, `osascript`, System Events, or other GUI
  automation for Flutter reload/restart.
- If the helper fails, times out, or cannot attach, preserve the app and report the
  exact helper output. Do not fall back to the owning IDE and do not treat an IDE
  window becoming frontmost as runtime progress.
- Never send `q` unless the user explicitly wants to terminate the app on the device.
- A successful attach must show the standard Flutter key commands and a Dart VM Service URL.
- If discovery cannot find a `vm-service-uri`, stop and report the exact blocker instead of guessing.
- The helper uses `Ctrl-C` to detach the temporary attach client after one-shot reload or restart. That must not be treated as a request to kill the app session.
- Treat `Could not update files on device`, `PathNotFoundException`, rejected reload/restart messages, or compile errors as failed reload/restart even if the Flutter tool also prints `Restarted application in ...`.
- Do not infer that the live DevFS is broken by scanning historical
  `.dart_tool/flutter_build/**/flutter_assets.d` files. Only fresh Flutter output from
  the selected runtime can prove an update failure. If it reports a deleted asset or
  stale graph, stop repeated attempts and hand cold-start authorization to the platform
  QA skill; do not rebuild or replace the live process from this transport skill.
- For `owner.type=ide_debug_adapter` or `owner.type=machine_run`, never attach, reload,
  or restart through this helper.
- Incomplete or unknown ownership metadata must still fail closed.
- Missing, malformed, or unreconstructable compile identity must fail closed. Never
  remove the target/define guard or hand-build a weaker attach command.

## Reliability Rules

Prefer the candidate that matches, in this order:

1. explicit project filter
2. explicit device filter
3. explicit Flutter binary or project FVM config
4. booted iOS simulator or named Android device
5. matched `development-service` / `vm-service-uri`
6. newest running session

Use the script output instead of hand-building the attach command when possible.
On Android, pass the concrete device id when known, for example `--device-udid emulator-5554`.

## Hot Reload vs Hot Restart

Use `hot reload` when:

- only widget, styling, layout, or rendering code changed
- app state should be preserved

Use `hot restart` when:

- startup state, dependency injection, provider setup, globals, routes, or initialization changed
- hot reload succeeded technically but the expected UI change did not appear

## Typical Codex Tool Pattern

1. run `flutter_session_ctl.py discover` and inspect `owner.type`
2. inspect that `attach_command` preserves the selected target and environment defines
3. stop runtime control for `ide_debug_adapter` or `machine_run` and continue with platform QA only
4. for a safely attachable standalone session, prefer `reload` or `restart` for one-shot actions; use `attach` when an interactive client is needed
5. verify the expected environment from fresh in-app/runtime evidence after the action
6. never bypass the helper with a raw attach command or IDE GUI automation

Do not launch a separate app session while this workflow is active.
Do not navigate or capture UI evidence with this skill alone; hand that work back to
the Android or iOS platform QA skill.
