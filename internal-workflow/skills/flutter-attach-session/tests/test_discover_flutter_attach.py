#!/usr/bin/env python3

import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "discover_flutter_attach.py"
)
SPEC = importlib.util.spec_from_file_location("discover_flutter_attach", SCRIPT)
discover = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(discover)


class DiscoverFlutterAttachTests(unittest.TestCase):
    def test_procargs2_parser_preserves_argv_boundaries(self) -> None:
        argv = ["flutter", "run", "--dart-define", "GREETING=hello world"]
        data = (
            len(argv).to_bytes(4, byteorder="little", signed=True)
            + b"/path/to/flutter\0\0"
            + b"\0".join(value.encode() for value in argv)
            + b"\0ENV=value\0"
        )

        self.assertEqual(discover.parse_procargs2(data), argv)

    def test_relative_target_is_resolved_from_runner_cwd(self) -> None:
        self.assertEqual(
            discover.resolve_run_target(
                ["flutter", "run", "--target", "lib/main_dev.dart"],
                "/repo/app",
            ),
            "/repo/app/lib/main_dev.dart",
        )

    def test_short_and_positional_targets_are_resolved(self) -> None:
        self.assertEqual(
            discover.resolve_run_target(
                ["flutter", "run", "-t", "lib/main_dev.dart"],
                "/repo/app",
            ),
            "/repo/app/lib/main_dev.dart",
        )
        self.assertEqual(
            discover.resolve_run_target(
                ["flutter", "run", "-tlib/main_dev.dart"],
                "/repo/app",
            ),
            "/repo/app/lib/main_dev.dart",
        )
        self.assertEqual(
            discover.resolve_run_target(
                ["flutter", "run", "-t=lib/main_dev.dart"],
                "/repo/app",
            ),
            "/repo/app/=lib/main_dev.dart",
        )
        self.assertEqual(
            discover.resolve_run_target(
                ["flutter", "run", "lib/main_dev.dart"],
                "/repo/app",
            ),
            "/repo/app/lib/main_dev.dart",
        )

    def test_malformed_target_is_rejected(self) -> None:
        for argv in (
            ["flutter", "run", "--target"],
            ["flutter", "run", "--target="],
            ["flutter", "run", "--target", "--dart-define=MODE=DEV"],
            ["flutter", "run", "--target", ""],
        ):
            with self.subTest(argv=argv), self.assertRaisesRegex(
                SystemExit, "compile identity"
            ):
                discover.resolve_run_target(argv, "/repo/app")

    def test_last_repeated_target_wins_like_flutter_arg_parser(self) -> None:
        self.assertEqual(
            discover.resolve_run_target(
                [
                    "flutter",
                    "run",
                    "--target",
                    "lib/main_dev.dart",
                    "-tlib/main.dart",
                ],
                "/repo/app",
            ),
            "/repo/app/lib/main.dart",
        )

    def test_attach_command_preserves_target_and_dart_defines(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="emulator-5554",
            target="/repo/lib/main_dev.dart",
            command=(
                "flutter run -d emulator-5554 --target /repo/lib/main_dev.dart "
                "--dart-define PRODUCT_MODE=full "
                "--dart-define=BASE_URL=https://api-dev.example/v1 "
                "-DMODE=DEV "
                "--dart-define-from-file env/dev.json"
            ),
            parent_command="/bin/zsh",
            argv=[
                "flutter",
                "run",
                "--target",
                "/repo/lib/main_dev.dart",
                "--dart-define",
                "PRODUCT_MODE=full",
                "--dart-define=BASE_URL=https://api-dev.example/v1",
                "-DMODE=DEV",
                "--dart-define-from-file",
                "env/dev.json",
            ],
        )

        command = discover.build_attach_command(
            run,
            service=None,
            debug_uri=None,
            flutter_bin="flutter",
        )

        self.assertEqual(
            command,
            [
                "flutter",
                "attach",
                "--target",
                "/repo/lib/main_dev.dart",
                "--dart-define",
                "PRODUCT_MODE=full",
                "--dart-define",
                "BASE_URL=https://api-dev.example/v1",
                "--dart-define",
                "MODE=DEV",
                "--dart-define-from-file",
                "env/dev.json",
                "--device-id",
                "emulator-5554",
            ],
        )

    def test_attach_command_refuses_unknown_target(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd=None,
            device_id="emulator-5554",
            target=None,
            command="flutter run -d emulator-5554",
            parent_command="/bin/zsh",
            argv=["flutter", "run", "-d", "emulator-5554"],
        )

        with self.assertRaisesRegex(SystemExit, "compile identity"):
            discover.build_attach_command(
                run,
                service=None,
                debug_uri=None,
                flutter_bin="flutter",
            )

    def test_attach_command_refuses_malformed_dart_define(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="emulator-5554",
            target="/repo/lib/main_dev.dart",
            command="flutter run --target /repo/lib/main_dev.dart --dart-define",
            parent_command="/bin/zsh",
            argv=[
                "flutter",
                "run",
                "--target",
                "/repo/lib/main_dev.dart",
                "--dart-define",
            ],
        )

        with self.assertRaisesRegex(SystemExit, "without a value"):
            discover.build_attach_command(
                run,
                service=None,
                debug_uri=None,
                flutter_bin="flutter",
            )

    def test_attach_command_preserves_define_value_with_whitespace(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="emulator-5554",
            target="/repo/lib/main_dev.dart",
            command="flattened ps output cannot preserve this value",
            parent_command="/bin/zsh",
            argv=[
                "flutter",
                "run",
                "--target",
                "/repo/lib/main_dev.dart",
                "--dart-define",
                "GREETING=hello world",
            ],
        )

        command = discover.build_attach_command(run, None, None, "flutter")

        self.assertIn("GREETING=hello world", command)

    def test_legacy_dart_defines_alias_is_preserved(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="emulator-5554",
            target="/repo/lib/main_dev.dart",
            command="flutter run",
            parent_command="/bin/zsh",
            argv=[
                "flutter",
                "run",
                "--target",
                "/repo/lib/main_dev.dart",
                "--dart-defines=MODE=DEV",
                "--dart-defines",
                "BASE_URL=https://api-dev.example/v1",
            ],
        )

        command = discover.build_attach_command(run, None, None, "flutter")

        self.assertEqual(
            command[4:8],
            [
                "--dart-define",
                "MODE=DEV",
                "--dart-define",
                "BASE_URL=https://api-dev.example/v1",
            ],
        )

    def test_define_followed_by_another_flag_is_rejected(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="emulator-5554",
            target="/repo/lib/main_dev.dart",
            command="flutter run",
            parent_command="/bin/zsh",
            argv=[
                "flutter",
                "run",
                "--target",
                "/repo/lib/main_dev.dart",
                "--dart-define",
                "--device-id",
                "emulator-5554",
            ],
        )

        with self.assertRaisesRegex(SystemExit, "without a value"):
            discover.build_attach_command(run, None, None, "flutter")

    def test_empty_define_file_value_is_rejected(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="emulator-5554",
            target="/repo/lib/main_dev.dart",
            command="flutter run",
            parent_command="/bin/zsh",
            argv=[
                "flutter",
                "run",
                "--target",
                "/repo/lib/main_dev.dart",
                "--dart-define-from-file",
                "",
            ],
        )

        with self.assertRaisesRegex(SystemExit, "without a value"):
            discover.build_attach_command(run, None, None, "flutter")

    def test_display_attach_command_redacts_define_values(self) -> None:
        command = [
            "flutter",
            "attach",
            "--dart-define",
            "API_TOKEN=super-secret",
            "--dart-define-from-file",
            "/private/dev.env",
        ]

        display = discover.redact_attach_command(command)

        self.assertNotIn("super-secret", display)
        self.assertNotIn("/private/dev.env", display)
        self.assertIn("API_TOKEN=[REDACTED]", display)

    def test_public_candidate_redacts_raw_commands(self) -> None:
        candidate = {
            "run": {
                "command": "flutter run --dart-define API_TOKEN=fake-secret",
                "parent_command": "sh -c flutter run --dart-define PARENT_TOKEN=parent-secret",
            },
            "attach_command": [
                "flutter",
                "attach",
                "--dart-define",
                "API_TOKEN=fake-secret",
                "--dart-define-from-file",
                "/private/dev.env",
            ],
            "attach_command_shell": "unsafe",
        }

        public = discover.sanitize_candidate_for_display(candidate)
        serialized = str(public)

        self.assertNotIn("fake-secret", serialized)
        self.assertNotIn("parent-secret", serialized)
        self.assertNotIn("/private/dev.env", serialized)
        self.assertIn("API_TOKEN=[REDACTED]", serialized)

    def test_project_match_does_not_accept_sibling_prefix(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo/app-old",
            device_id="emulator-5554",
            target="/repo/app-old/lib/main.dart",
            command="flutter run -d emulator-5554",
            parent_command="/bin/zsh",
        )

        self.assertFalse(discover.looks_like_project_match("/repo/app", run))

    def test_service_match_requires_direct_flutter_run_parent(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="emulator-5554",
            target="/repo/lib/main.dart",
            command="flutter run -d emulator-5554",
            parent_command="/bin/zsh",
        )
        service = discover.DevelopmentService(
            pid=20,
            ppid=99,
            elapsed_seconds=5,
            cwd="/repo",
            vm_service_uri="http://127.0.0.1:1/token/",
            command="dart development-service",
        )

        self.assertIsNone(discover.pick_service(run, [service]))

    def test_device_name_match_does_not_accept_substring(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="SIM-1",
            target="/repo/lib/main.dart",
            command="flutter run -d SIM-1",
            parent_command="/bin/zsh",
        )
        devices = {
            "SIM-1": discover.Device(
                udid="SIM-1",
                name="iPhone 16 Pro",
                state="Booted",
                runtime="iOS 18.0",
            )
        }

        self.assertFalse(
            discover.matches_requested_device(
                run,
                devices=devices,
                device_udid=None,
                device_name="iPhone 16",
            )
        )

    def test_unknown_owner_is_not_attach_safe(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="emulator-5554",
            target="/repo/lib/main.dart",
            command="flutter run -d emulator-5554",
            parent_command="python launcher.py",
        )

        owner = discover.classify_owner(run)

        self.assertEqual(owner["type"], "unknown")
        self.assertFalse(owner["attach_safe"])

    def test_machine_run_is_not_safe_for_second_attach(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="emulator-5554",
            target="/repo/lib/main.dart",
            command="flutter run --machine -d emulator-5554",
            parent_command="",
        )

        owner = discover.classify_owner(run)

        self.assertEqual(owner["type"], "machine_run")
        self.assertFalse(owner["attach_safe"])

    def test_ide_debug_adapter_is_not_safe_for_second_attach(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="emulator-5554",
            target="/repo/lib/main.dart",
            command="flutter run -d emulator-5554",
            parent_command="flutter_tools.snapshot debug_adapter",
        )

        owner = discover.classify_owner(run)

        self.assertEqual(owner["type"], "ide_debug_adapter")
        self.assertFalse(owner["attach_safe"])

    def test_android_forwarded_vm_service_uri_uses_device_side_port(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="emulator-5554",
            target="/repo/lib/main.dart",
            command="flutter run -d emulator-5554",
            parent_command="",
            argv=["flutter", "run", "-d", "emulator-5554"],
        )
        service = discover.DevelopmentService(
            pid=20,
            ppid=10,
            elapsed_seconds=4,
            cwd="/repo",
            vm_service_uri="http://127.0.0.1:60185/I6ndJrHtDvU=/",
            command="dart development-service",
        )

        def fake_run_command(cmd: list[str], *, check: bool = True):
            self.assertEqual(cmd, ["adb", "-s", "emulator-5554", "forward", "--list"])
            return subprocess.CompletedProcess(
                cmd,
                0,
                stdout="emulator-5554 tcp:60185 tcp:36673\n",
                stderr="",
            )

        with patch.object(discover, "run_command", side_effect=fake_run_command):
            candidate = discover.format_candidate(run, service, {}, "flutter")

        self.assertEqual(
            candidate["attach_command"],
            [
                "flutter",
                "attach",
                "--target",
                "/repo/lib/main.dart",
                "--device-id",
                "emulator-5554",
                "--debug-uri",
                "http://127.0.0.1:36673/I6ndJrHtDvU=/",
            ],
        )
        self.assertEqual(
            candidate["debug_uri_resolution"]["reason"],
            "adb_host_forward_resolved_to_device_port",
        )

    def test_non_forwarded_vm_service_uri_is_preserved(self) -> None:
        run = discover.FlutterRunSession(
            pid=10,
            ppid=1,
            elapsed_seconds=5,
            cwd="/repo",
            device_id="emulator-5554",
            target="/repo/lib/main.dart",
            command="flutter run -d emulator-5554",
            parent_command="",
            argv=["flutter", "run", "-d", "emulator-5554"],
        )
        service = discover.DevelopmentService(
            pid=20,
            ppid=10,
            elapsed_seconds=4,
            cwd="/repo",
            vm_service_uri="http://127.0.0.1:60185/I6ndJrHtDvU=/",
            command="dart development-service",
        )

        def fake_run_command(cmd: list[str], *, check: bool = True):
            return subprocess.CompletedProcess(
                cmd,
                0,
                stdout="emulator-5554 tcp:59999 tcp:36673\n",
                stderr="",
            )

        with patch.object(discover, "run_command", side_effect=fake_run_command):
            candidate = discover.format_candidate(run, service, {}, "flutter")

        self.assertEqual(candidate["attach_command"][-1], service.vm_service_uri)
        self.assertEqual(
            candidate["debug_uri_resolution"]["reason"],
            "no_matching_adb_forward",
        )


if __name__ == "__main__":
    unittest.main()
