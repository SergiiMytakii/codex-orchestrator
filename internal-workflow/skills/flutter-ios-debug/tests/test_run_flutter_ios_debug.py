#!/usr/bin/env python3

import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run_flutter_ios_debug.py"
SPEC = importlib.util.spec_from_file_location("run_flutter_ios_debug", SCRIPT)
ios_debug = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(ios_debug)


class FlutterIOSDebugTests(unittest.TestCase):
    def test_running_process_detection_blocks_machine_run_and_runner(self) -> None:
        result = subprocess.CompletedProcess(
            ["ps"],
            0,
            stdout=(
                "101 flutter_tools.snapshot run --machine -d SIM-1\n"
                "102 /tmp/Runner.app/Runner\n"
                "103 python run_flutter_ios_debug.py\n"
            ),
            stderr="",
        )

        with patch.object(ios_debug, "run_command", return_value=result):
            running = ios_debug.list_running_flutter_runs(False)

        self.assertEqual(running, [
            "101 flutter_tools.snapshot run --machine -d SIM-1",
            "102 /tmp/Runner.app/Runner",
        ])

    def test_non_tty_login_failure_waits_for_child_cleanup(self) -> None:
        process = Mock()
        process.poll.return_value = None
        process.wait.return_value = 3

        with (
            patch.object(ios_debug.subprocess, "Popen", return_value=process),
            patch.object(ios_debug.sys.stdin, "isatty", return_value=False),
        ):
            result = ios_debug.run_flutter_with_optional_login_wait(
                ["flutter", "run"],
                project_dir=Path("/repo"),
                wait_for_login=True,
            )

        self.assertEqual(result, 3)
        process.terminate.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=5)


if __name__ == "__main__":
    unittest.main()
