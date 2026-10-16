#!/usr/bin/env python3

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "flutter_session_ctl.py"
)
SPEC = importlib.util.spec_from_file_location("flutter_session_ctl", SCRIPT)
session_ctl = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(session_ctl)


def discovery_payload(*, pid: int, attach_safe: bool) -> dict:
    return {
        "selected": {
            "attach_command": ["flutter", "attach", "--debug-uri", "http://127.0.0.1:1/token/"],
            "run": {"pid": pid, "cwd": "/repo"},
            "owner": {
                "type": "terminal_run" if attach_safe else "ide_debug_adapter",
                "attach_safe": attach_safe,
                "reason": "test owner classification",
            },
        }
    }


class FlutterSessionControlTests(unittest.TestCase):
    def test_interactive_attach_does_not_print_define_values(self) -> None:
        command = ["flutter", "attach", "--dart-define", "API_TOKEN=super-secret"]

        with (
            patch("builtins.print") as output,
            patch.object(session_ctl.subprocess, "call", return_value=0),
        ):
            result = session_ctl.relay_interactive_attach(command, "/repo")

        self.assertEqual(result, 0)
        self.assertNotIn("super-secret", str(output.call_args_list))

    def test_runtime_identity_change_is_rejected(self) -> None:
        before = discovery_payload(pid=42, attach_safe=True)
        after = discovery_payload(pid=43, attach_safe=True)

        with self.assertRaisesRegex(SystemExit, "runtime identity changed: run.pid"):
            session_ctl.assert_runtime_identity_unchanged(before, after)

    def test_dead_pinned_runtime_is_reported_after_successful_reload(self) -> None:
        process = Mock()

        with (
            patch.object(session_ctl.pty, "openpty", return_value=(10, 11)),
            patch.object(session_ctl.termios, "tcgetattr", return_value=[0, 0, 0, 0]),
            patch.object(session_ctl.termios, "tcsetattr"),
            patch.object(session_ctl.subprocess, "Popen", return_value=process),
            patch.object(session_ctl, "read_until", side_effect=[("ready", "Flutter run key commands."), ("Reloaded 1 libraries", "Reloaded ")]),
            patch.object(session_ctl, "is_process_alive", return_value=False),
            patch.object(session_ctl, "terminate_attach_process"),
            patch.object(session_ctl.os, "write"),
            patch.object(session_ctl.os, "close"),
        ):
            result = session_ctl.one_shot_command(
                ["flutter", "attach"],
                cwd="/repo",
                action_key="r",
                ready_timeout=1,
                result_timeout=1,
                expected_pid=42,
            )

        self.assertEqual(result, 11)

    def test_dead_development_service_is_reported_after_successful_reload(self) -> None:
        process = Mock()

        with (
            patch.object(session_ctl.pty, "openpty", return_value=(10, 11)),
            patch.object(session_ctl.termios, "tcgetattr", return_value=[0, 0, 0, 0]),
            patch.object(session_ctl.termios, "tcsetattr"),
            patch.object(session_ctl.subprocess, "Popen", return_value=process),
            patch.object(session_ctl, "read_until", side_effect=[("ready", "Flutter run key commands."), ("Reloaded 1 libraries", "Reloaded ")]),
            patch.object(session_ctl, "is_process_alive", side_effect=[True, False]),
            patch.object(session_ctl, "terminate_attach_process"),
            patch.object(session_ctl.os, "write"),
            patch.object(session_ctl.os, "close"),
        ):
            result = session_ctl.one_shot_command(
                ["flutter", "attach"],
                cwd="/repo",
                action_key="r",
                ready_timeout=1,
                result_timeout=1,
                expected_pid=42,
                expected_service_pid=43,
            )

        self.assertEqual(result, 12)

    def test_one_shot_terminates_attach_process_when_read_fails(self) -> None:
        process = Mock()

        with (
            patch.object(session_ctl.pty, "openpty", return_value=(10, 11)),
            patch.object(session_ctl.termios, "tcgetattr", return_value=[0, 0, 0, 0]),
            patch.object(session_ctl.termios, "tcsetattr"),
            patch.object(session_ctl.subprocess, "Popen", return_value=process),
            patch.object(session_ctl, "read_until", side_effect=RuntimeError("read failed")),
            patch.object(session_ctl, "terminate_attach_process") as terminate,
            patch.object(session_ctl.os, "close"),
            self.assertRaisesRegex(RuntimeError, "read failed"),
        ):
            session_ctl.one_shot_command(
                ["flutter", "attach"],
                cwd="/repo",
                action_key="r",
                ready_timeout=1,
                result_timeout=1,
            )

        terminate.assert_called_once_with(process)

    def test_interactive_attach_refuses_ide_owned_session(self) -> None:
        payload = discovery_payload(pid=42, attach_safe=False)

        with (
            patch.object(
                sys,
                "argv",
                ["flutter_session_ctl.py", "attach", "--expected-pid", "42"],
            ),
            patch.object(session_ctl, "run_discovery", return_value=payload),
            patch.object(session_ctl, "relay_interactive_attach") as relay,
            self.assertRaises(SystemExit) as raised,
        ):
            session_ctl.main()

        self.assertEqual(raised.exception.code, 8)
        relay.assert_not_called()

    def test_removed_tool_owned_flag_cannot_override_ide_owner(self) -> None:
        payload = discovery_payload(pid=42, attach_safe=False)

        with (
            patch.object(
                sys,
                "argv",
                [
                    "flutter_session_ctl.py",
                    "attach",
                    "--expected-pid",
                    "42",
                    "--allow-tool-owned",
                ],
            ),
            patch.object(session_ctl, "run_discovery", return_value=payload),
            patch.object(session_ctl, "relay_interactive_attach") as relay,
            self.assertRaises(SystemExit) as raised,
        ):
            session_ctl.main()

        self.assertEqual(raised.exception.code, 2)
        relay.assert_not_called()

    def test_one_shot_actions_refuse_machine_owned_session(self) -> None:
        payload = discovery_payload(pid=42, attach_safe=False)
        payload["selected"]["owner"]["type"] = "machine_run"

        for action in ("reload", "restart"):
            with (
                self.subTest(action=action),
                patch.object(
                    sys,
                    "argv",
                    [
                        "flutter_session_ctl.py",
                        action,
                        "--expected-pid",
                        "42",
                    ],
                ),
                patch.object(session_ctl, "run_discovery", return_value=payload),
                patch.object(session_ctl, "one_shot_command") as one_shot,
                patch.object(session_ctl, "verify_runtime_after_action") as verify,
                self.assertRaises(SystemExit) as raised,
            ):
                session_ctl.main()

            self.assertEqual(raised.exception.code, 8)
            one_shot.assert_not_called()
            verify.assert_not_called()

    def test_reload_refuses_runtime_that_changed_after_discovery(self) -> None:
        payload = discovery_payload(pid=42, attach_safe=True)

        with (
            patch.object(
                sys,
                "argv",
                ["flutter_session_ctl.py", "reload", "--expected-pid", "41"],
            ),
            patch.object(session_ctl, "run_discovery", return_value=payload),
            patch.object(session_ctl, "one_shot_command") as one_shot,
            self.assertRaises(SystemExit) as raised,
        ):
            session_ctl.main()

        self.assertEqual(raised.exception.code, 9)
        one_shot.assert_not_called()

    def test_runtime_control_requires_pinned_pid(self) -> None:
        payload = discovery_payload(pid=42, attach_safe=True)

        with (
            patch.object(sys, "argv", ["flutter_session_ctl.py", "attach"]),
            patch.object(session_ctl, "run_discovery", return_value=payload),
            patch.object(session_ctl, "relay_interactive_attach") as relay,
            self.assertRaises(SystemExit) as raised,
        ):
            session_ctl.main()

        self.assertEqual(raised.exception.code, 10)
        relay.assert_not_called()

    def test_interactive_attach_relays_matching_safe_session(self) -> None:
        payload = discovery_payload(pid=42, attach_safe=True)

        with (
            patch.object(
                sys,
                "argv",
                ["flutter_session_ctl.py", "attach", "--expected-pid", "42"],
            ),
            patch.object(session_ctl, "run_discovery", return_value=payload),
            patch.object(session_ctl, "relay_interactive_attach", return_value=0) as relay,
        ):
            result = session_ctl.main()

        self.assertEqual(result, 0)
        relay.assert_called_once_with(payload["selected"]["attach_command"], "/repo")

    def test_unreconstructable_compile_identity_blocks_every_control_action(self) -> None:
        for action in ("attach", "reload", "restart"):
            with (
                self.subTest(action=action),
                patch.object(sys, "argv", ["ctl", action, "--expected-pid", "42"]),
                patch.object(session_ctl, "run_discovery", side_effect=SystemExit("compile identity unavailable")),
                patch.object(session_ctl, "one_shot_command") as one_shot,
                patch.object(session_ctl, "relay_interactive_attach") as relay,
                patch.object(session_ctl.subprocess, "run") as run,
                patch.object(session_ctl.subprocess, "Popen") as popen,
                self.assertRaisesRegex(SystemExit, "compile identity unavailable"),
            ):
                session_ctl.main()
            one_shot.assert_not_called()
            relay.assert_not_called()
            run.assert_not_called()
            popen.assert_not_called()

    def test_failed_reload_or_restart_stops_without_runtime_fallback(self) -> None:
        payload = discovery_payload(pid=42, attach_safe=True)
        for action in ("reload", "restart"):
            for failure in (4, 5, 6, 11, 12):
                with (
                    self.subTest(action=action, failure=failure),
                    patch.object(sys, "argv", ["ctl", action, "--expected-pid", "42"]),
                    patch.object(session_ctl, "run_discovery", return_value=payload),
                    patch.object(session_ctl, "one_shot_command", return_value=failure),
                    patch.object(session_ctl, "verify_runtime_after_action") as verify,
                    patch.object(session_ctl.subprocess, "run") as run,
                    patch.object(session_ctl.subprocess, "Popen") as popen,
                    patch.object(session_ctl.subprocess, "call") as call,
                ):
                    self.assertEqual(session_ctl.main(), failure)
                verify.assert_not_called()
                run.assert_not_called()
                popen.assert_not_called()
                call.assert_not_called()

    def test_attach_refuses_missing_owner_metadata(self) -> None:
        payload = discovery_payload(pid=42, attach_safe=True)
        del payload["selected"]["owner"]

        with (
            patch.object(
                sys,
                "argv",
                ["flutter_session_ctl.py", "attach", "--expected-pid", "42"],
            ),
            patch.object(session_ctl, "run_discovery", return_value=payload),
            patch.object(session_ctl, "relay_interactive_attach") as relay,
            self.assertRaises(SystemExit) as raised,
        ):
            session_ctl.main()

        self.assertEqual(raised.exception.code, 8)
        relay.assert_not_called()

    def test_unknown_owner_is_refused(self) -> None:
        payload = discovery_payload(pid=42, attach_safe=False)
        payload["selected"]["owner"]["type"] = "unknown"

        with (
            patch.object(
                sys,
                "argv",
                [
                    "flutter_session_ctl.py",
                    "attach",
                    "--expected-pid",
                    "42",
                ],
            ),
            patch.object(session_ctl, "run_discovery", return_value=payload),
            patch.object(session_ctl, "relay_interactive_attach") as relay,
            self.assertRaises(SystemExit) as raised,
        ):
            session_ctl.main()

        self.assertEqual(raised.exception.code, 8)
        relay.assert_not_called()


if __name__ == "__main__":
    unittest.main()
