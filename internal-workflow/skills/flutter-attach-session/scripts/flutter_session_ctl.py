#!/usr/bin/env python3

import argparse
import json
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DISCOVERY_SCRIPT = ROOT / "discover_flutter_attach.py"


def run_discovery(
    *,
    project: str | None,
    device_udid: str | None,
    device_name: str | None,
    flutter_bin: str | None,
    include_sensitive_command: bool = False,
) -> dict:
    output_flag = "--control-json" if include_sensitive_command else "--json"
    cmd = [sys.executable, str(DISCOVERY_SCRIPT), output_flag]
    if project:
        cmd.extend(["--project", project])
    if device_udid:
        cmd.extend(["--device-udid", device_udid])
    if device_name:
        cmd.extend(["--device-name", device_name])
    if flutter_bin:
        cmd.extend(["--flutter-bin", flutter_bin])

    result = subprocess.run(cmd, text=True, capture_output=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr or result.stdout or "Flutter session discovery failed.\n")
        raise SystemExit(result.returncode)

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"Discovery returned invalid JSON: {error}") from error


def resolve_attach_command(payload: dict) -> tuple[list[str], str | None]:
    selected = payload.get("selected") or {}
    attach_command = selected.get("attach_command")
    if not attach_command:
        raise SystemExit("Discovery did not return an attach command.")

    cwd = ((selected.get("run") or {}).get("cwd")) or None
    return list(attach_command), cwd


def assert_attach_is_allowed(payload: dict) -> None:
    selected = payload.get("selected") or {}
    owner = selected.get("owner") or {}
    owner_type = owner.get("type")
    if owner_type == "terminal_run" and owner.get("attach_safe") is True:
        return
    owner_type = owner_type or "unknown"
    reason = owner.get("reason") or "The selected Flutter session is not safe for a second attach client."
    run = selected.get("run") or {}
    sys.stderr.write(
        "Refusing flutter attach for this session.\n"
        f"- owner: {owner_type}\n"
        f"- pid: {run.get('pid', 'unknown')}\n"
        f"- cwd: {run.get('cwd', 'unknown')}\n"
        f"- reason: {reason}\n"
        "\n"
        "IDE/debug-adapter and machine-run owners must keep their original controller. "
        "Use platform QA for inspection/navigation and ask the user to trigger reload/restart.\n"
    )
    raise SystemExit(8)


def assert_selected_runtime_matches(payload: dict, *, expected_pid: int | None) -> None:
    selected = payload.get("selected") or {}
    run = selected.get("run") or {}
    selected_pid = run.get("pid")

    if expected_pid is None:
        sys.stderr.write(
            "Refusing runtime control without a pinned session PID.\n"
            "Run discover --json, inspect selected.run.pid, then pass "
            "--expected-pid <pid> to attach/reload/restart.\n"
        )
        raise SystemExit(10)

    if selected_pid == expected_pid:
        return

    sys.stderr.write(
        "Refusing runtime control because the selected Flutter session changed.\n"
        f"- expected pid: {expected_pid}\n"
        f"- selected pid: {selected_pid if selected_pid is not None else 'unknown'}\n"
        f"- selected cwd: {run.get('cwd', 'unknown')}\n"
        "Run discovery again and re-confirm the runtime before taking action.\n"
    )
    raise SystemExit(9)


def assert_runtime_identity_unchanged(before: dict, after: dict) -> None:
    before_selected = before.get("selected") or {}
    after_selected = after.get("selected") or {}
    before_run = before_selected.get("run") or {}
    after_run = after_selected.get("run") or {}
    before_service = before_selected.get("development_service") or {}
    after_service = after_selected.get("development_service") or {}

    identity_fields = (
        ("run.pid", before_run.get("pid"), after_run.get("pid")),
        ("run.cwd", before_run.get("cwd"), after_run.get("cwd")),
        ("run.device_id", before_run.get("device_id"), after_run.get("device_id")),
        ("run.target", before_run.get("target"), after_run.get("target")),
        ("development_service.pid", before_service.get("pid"), after_service.get("pid")),
        ("development_service.vm_service_uri", before_service.get("vm_service_uri"), after_service.get("vm_service_uri")),
    )
    changed = [name for name, expected, actual in identity_fields if expected != actual]
    if changed:
        raise SystemExit(
            "Refusing to claim reload/restart success because the runtime identity changed: "
            + ", ".join(changed)
        )


def verify_runtime_after_action(payload: dict, args: argparse.Namespace) -> None:
    after = run_discovery(
        project=args.project,
        device_udid=args.device_udid,
        device_name=args.device_name,
        flutter_bin=args.flutter_bin,
    )
    assert_runtime_identity_unchanged(payload, after)


def relay_interactive_attach(attach_command: list[str], cwd: str | None) -> int:
    print("Starting flutter attach with preserved compile identity (define values redacted).")
    return subprocess.call(attach_command, cwd=cwd)


def read_until(fd: int, patterns: list[str], *, timeout_seconds: float) -> tuple[str, str | None]:
    deadline = time.monotonic() + timeout_seconds
    transcript = ""

    while time.monotonic() < deadline:
        remaining = max(0.1, deadline - time.monotonic())
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            continue

        try:
            chunk = os.read(fd, 4096).decode(errors="replace")
        except OSError:
            break

        if not chunk:
            break

        transcript += chunk
        for pattern in patterns:
            if pattern in transcript:
                return transcript, pattern

    return transcript, None


def terminate_attach_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return

    process.send_signal(signal.SIGINT)
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)


def is_process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except (OSError, ProcessLookupError):
        return False
    return True


def one_shot_command(
    attach_command: list[str],
    *,
    cwd: str | None,
    action_key: str,
    ready_timeout: float,
    result_timeout: float,
    expected_pid: int | None = None,
    expected_service_pid: int | None = None,
) -> int:
    master_fd, slave_fd = pty.openpty()
    attrs = termios.tcgetattr(slave_fd)
    attrs[3] = attrs[3] & ~termios.ECHO
    termios.tcsetattr(slave_fd, termios.TCSANOW, attrs)
    process = subprocess.Popen(
        attach_command,
        cwd=cwd,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        text=True,
        close_fds=True,
    )

    try:
        os.close(slave_fd)
        ready_output, ready_pattern = read_until(
            master_fd,
            ["Flutter run key commands.", "A Dart VM Service on"],
            timeout_seconds=ready_timeout,
        )
        sys.stdout.write(ready_output)
        sys.stdout.flush()

        if ready_pattern is None:
            terminate_attach_process(process)
            sys.stderr.write("Attach session did not become ready in time.\n")
            return 4

        os.write(master_fd, action_key.encode())

        failure_patterns = [
            "Could not update files on device:",
            "PathNotFoundException:",
            "Hot reload was rejected:",
            "Hot restart was rejected:",
            "Try again after fixing the above error",
        ]
        success_patterns = ["Reloaded ", "Restarted application in "]
        result_output, result_pattern = read_until(
            master_fd,
            failure_patterns + success_patterns,
            timeout_seconds=result_timeout,
        )
        sys.stdout.write(result_output)
        sys.stdout.flush()

        if result_pattern in failure_patterns:
            terminate_attach_process(process)
            sys.stderr.write(
                "Attach command reported a Flutter update failure; leaving the app running and reporting failure.\n"
            )
            return 6

        if result_pattern is None:
            terminate_attach_process(process)
            sys.stderr.write("Attach command did not report a successful result in time.\n")
            return 5

        if expected_pid is not None and not is_process_alive(expected_pid):
            terminate_attach_process(process)
            sys.stderr.write(
                f"Flutter run process {expected_pid} disappeared during {action_key!r}; "
                "the live session was not preserved.\n"
            )
            return 11

        if expected_service_pid is not None and not is_process_alive(expected_service_pid):
            terminate_attach_process(process)
            sys.stderr.write(
                f"Flutter development service {expected_service_pid} disappeared during {action_key!r}; "
                "the VM Service identity was not preserved.\n"
            )
            return 12

        terminate_attach_process(process)
        return 0
    finally:
        terminate_attach_process(process)
        try:
            os.close(master_fd)
        except OSError:
            pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Attach to a live Flutter session, or perform one-shot hot reload/restart."
    )
    parser.add_argument(
        "action",
        choices=["discover", "attach", "reload", "restart"],
        help="Operation to perform on the current live Flutter session.",
    )
    parser.add_argument("--project", help="Preferred Flutter project root.")
    parser.add_argument("--device-udid", help="Preferred simulator or device UDID.")
    parser.add_argument("--device-name", help="Preferred simulator or device name.")
    parser.add_argument(
        "--flutter-bin",
        "--flutter",
        dest="flutter_bin",
        help="Flutter binary to use for attach.",
    )
    parser.add_argument(
        "--ready-timeout",
        type=float,
        default=45.0,
        help="Seconds to wait for flutter attach to become ready.",
    )
    parser.add_argument(
        "--result-timeout",
        type=float,
        default=20.0,
        help="Seconds to wait for reload or restart confirmation.",
    )
    parser.add_argument(
        "--expected-pid",
        type=int,
        help="PID confirmed by a preceding discover --json call; required for runtime control.",
    )
    parser.add_argument("--json", action="store_true", help="For discover, print JSON output.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = run_discovery(
        project=args.project,
        device_udid=args.device_udid,
        device_name=args.device_name,
        flutter_bin=args.flutter_bin,
        include_sensitive_command=args.action != "discover",
    )

    if args.action == "discover":
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            selected = payload["selected"]
            print(selected["attach_command_shell"])
        return 0

    attach_command, cwd = resolve_attach_command(payload)
    assert_selected_runtime_matches(payload, expected_pid=args.expected_pid)
    assert_attach_is_allowed(payload)

    if args.action == "attach":
        return relay_interactive_attach(attach_command, cwd)

    selected_service = (payload.get("selected") or {}).get("development_service") or {}
    expected_service_pid = selected_service.get("pid")

    if args.action == "reload":
        result = one_shot_command(
            attach_command,
            cwd=cwd,
            action_key="r",
            ready_timeout=args.ready_timeout,
            result_timeout=args.result_timeout,
            expected_pid=args.expected_pid,
            expected_service_pid=expected_service_pid,
        )
    else:
        result = one_shot_command(
            attach_command,
            cwd=cwd,
            action_key="R",
            ready_timeout=args.ready_timeout,
            result_timeout=args.result_timeout,
            expected_pid=args.expected_pid,
            expected_service_pid=expected_service_pid,
        )

    if result != 0:
        return result
    try:
        verify_runtime_after_action(payload, args)
    except SystemExit as error:
        sys.stderr.write(f"Post-action runtime verification failed: {error}\n")
        return 13
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
