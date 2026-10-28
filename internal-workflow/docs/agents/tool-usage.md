# Tool Usage

## MCP On Demand

Specialized local MCP servers, including Firebase and the standalone Node REPL,
should stay disabled by default unless a project has an intentional scoped
exception (for example Dart for mobile development). Remote documentation
and service connectors do not need disabling merely to reduce local Node RAM.

Maestro MCP stays disabled in chat configuration, including mobile projects.
Keep Maestro CLI installed. Use the project's bounded QA harness; its owned
Maestro session starts for the check and closes on exit. For a separately started
server, record ownership and apply `$task-resource-cleanup` after the check;
preserve another chat's or an active QA run's server.

1. Establish need: use the task, relevant skill and current configuration to decide
   whether MCP adds a required capability beyond existing tools, CLI or SDK. For
   Firebase, ordinary coding and the application's Firebase SDK do not require
   Firebase MCP; Firebase administration or Crashlytics inspection can justify it.
   Confirm the specific capability before enabling a server.
2. Enable narrowly: when needed, enable it autonomously within the user's task
   authorization. Prefer a supported per-task/session override or scoped client;
   verify that the required tool actually becomes available. A config edit alone
   is not proof of connection. Do not restart the app, unload another chat, or
   create a user-visible chat to load tools. If the current runtime cannot attach
   it safely, use a bounded CLI/SDK equivalent where authorized; explain any
   remaining need for the user to reload or start a chat only when it blocks work.
3. Track changes: record the prior setting, scope and task-owned resource handles.
   If a persistent setting must change, use the narrowest project scope and avoid
   broad enabling in the shared global configuration. Do not overwrite concurrent
   edits or toggle an integration another active task needs.
4. Finish: restore only this task's temporary configuration changes, provided the
   current value still matches what this task wrote and no other task relies on
   it. Release task-owned clients, REPL state and servers through their supported
   scoped close/reset/stop operations, and verify release. Apply `$task-resource-cleanup`
   to app-managed or uncertain connections: preserve them and report the
   limitation. Disabling future startup does not prove an existing process exited.

Do not invent an MCP idle-eviction setting. Startup and tool-call timeouts are not
idle cleanup. Do not add timer-based process killing or a stdio wrapper that exits
and silently breaks a running chat's connection.

## Flutter Debug Sessions

Local Flutter UI work always uses a platform QA skill plus the runtime ownership gate:

- Android emulator: always use `$flutter-android-debug` as the lifecycle orchestrator
  and `test-android-apps:android-emulator-qa` for navigation, interaction, UI trees,
  screenshots, and logcat, including inspection-only and screenshot-only requests.
- iOS Simulator: use `$flutter-ios-debug` for environment/login gates, navigation,
  interaction, screenshots, and visual comparison.
- Use `$flutter-attach-session` to discover the runtime owner and perform
  reload/restart against the selected live session.

Before any install, launch, attach, reload, restart, terminate, or force-stop:

1. Identify the project, target device, package/app, current PID, VM Service, runtime
   owner, and expected backend/environment.
2. Treat any live PID, VM Service, IDE debug adapter, `flutter run`, or visible app as
   user-owned state.
3. If an IDE/debug adapter or machine run owns DevFS, never attach a second Flutter
   compiler/controller. Preserve the session, continue only with inspection or in-app
   navigation, and ask the user to trigger `r`/`R` through the owning controller when
   reload/restart is necessary. Unknown owners remain blocked.
4. Use `r` for widget/layout/style/rendering changes and `R` for startup state,
   dependency injection, providers, globals, routes, or initialization changes.
5. Always pass the PID confirmed by `discover --json` as `--expected-pid`; never
   execute the raw discovered attach command.
6. Confirm that the generated attach command preserves the selected run's effective
   target and every `--dart-define` / `--dart-define-from-file`. Missing compile
   identity must block runtime control rather than fall back to defaults.
   Treat raw define values as sensitive; inspect only the helper's redacted display.
7. Verify that the same PID and expected environment remain after each runtime or
   navigation action.

The bundled `flutter_session_ctl.py` helper is the only allowed reload/restart
transport for safely attachable standalone sessions. Never activate, open, focus, or
automate an IDE for this purpose. Do not use IDE menus, Command Palette, keyboard
shortcuts, `osascript`, System Events, or other GUI automation. If the helper fails or
times out, preserve the app process and report its exact failure; do not fall back to
the IDE.

Requests to inspect, debug, navigate, capture screenshots, or verify UI do not authorize
build/install, uninstall, app-data clearing, force-stop, process termination, replacement
launch, or a new `flutter run`. Use those only when no live target exists and the user
requested a fresh run, or after explicit approval to replace the current session.

The platform QA skill owns navigation and evidence. Do not replace it with ad-hoc shell
commands: use `test-android-apps:android-emulator-qa` for Android emulator UI trees,
input, screenshots, and logcat, and `$flutter-ios-debug` for iOS Simulator environment
gates, navigation, interaction, screenshots, and visual comparison.

If the process disappears, stop and report it. Hot reload cannot restore a dead process,
and launching the installed app may expose an older APK/IPA without the DevFS changes.

For a cold launch, load the owning repository's launch configuration as the source of
truth for flavor, dart-defines, package/app identity, and backend. This applies only
after the cold-launch gate is satisfied.

## External Research

Prefer local evidence before external lookup. When external evidence is
material to a coding decision, use the source that owns the claim:

1. official documentation or specifications;
2. first-party source code, changelogs, release notes, or issue trackers;
3. first-party APIs or published schemas.

Use secondary sources only to discover primary sources or identify a disputed
interpretation. Record source version/date when freshness matters, separate
sourced facts from inference, and say when current behavior cannot be confirmed.

Keep one narrow lookup inline unless the user explicitly requests delegation or
a durable artifact. Use `$research` for either explicit request, multi-source
comparison, or material external contract synthesis. The skill owns the
Research Capsule, named-agent route, claim-to-source artifact, root verification,
and downstream handoff.

## Context7

Use Context7 only when the task genuinely requires precise, current documentation for a real package, framework, SDK, API, or implementation detail that cannot be confidently answered from local evidence or built-in knowledge.

Prefer local inspection first:

- source code
- lockfiles and installed package versions
- package manifests
- existing tests and examples
- local docs and configuration

Do not use Context7 for:

- routine coding
- general language questions
- simple refactors
- repository-specific behavior
- facts already visible in the project

If Context7 is used, keep the lookup narrow and bring back only the details needed for the active task.

- Reuse documentation already returned in the current conversation when it covers
  the same question and library version. Refresh it when version or freshness matters.
- When the exact Context7 library ID is already known, query that ID directly;
  resolve a library only when its identity or version is uncertain.
- Establish the installed library version from the lockfile or package metadata
  before a version-sensitive lookup. Use version-specific documentation when
  available; if only another version is available, verify applicability against
  the installed API or primary documentation before applying the result.
- Scope each query to one unresolved question, the target version, language, and
  platform. Request only the relevant API details and a minimal example rather
  than a broad tutorial; retain only excerpts needed for the decision.
- Check that returned sources and examples match the requested version and
  platform before relying on them. A language hint alone does not establish a match.
- If results are empty, irrelevant, for a different platform, or the lookup fails,
  consult the library's primary documentation instead of repeating equivalent
  queries. Retry only when a specific correctable cause has been identified.
