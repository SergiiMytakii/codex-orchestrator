#!/usr/bin/env python3

import argparse
import json
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass
class SimDevice:
    name: str
    udid: str
    state: str
    runtime: str


def runtime_sort_key(runtime: str) -> tuple[int, ...]:
    numbers = [int(num) for num in re.findall(r"\d+", runtime)]
    return tuple(numbers) if numbers else (0,)


def ensure_tools() -> None:
    missing = [tool for tool in ("flutter", "xcrun", "open") if shutil.which(tool) is None]
    if missing:
        raise SystemExit(f"Missing required tools: {', '.join(missing)}")


def run_command(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    check: bool = True,
    dry_run: bool = False,
    capture_output: bool = False,
) -> subprocess.CompletedProcess[str]:
    cmd_display = shlex.join(cmd)
    if cwd is None:
        print(f"+ {cmd_display}")
    else:
        print(f"+ (cd {cwd} && {cmd_display})")

    if dry_run:
        return subprocess.CompletedProcess(cmd, 0, "", "")

    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        check=check,
        text=True,
        capture_output=capture_output,
    )


def load_sim_devices(dry_run: bool) -> list[SimDevice]:
    result = run_command(
        ["xcrun", "simctl", "list", "devices", "--json"],
        check=True,
        dry_run=dry_run,
        capture_output=not dry_run,
    )

    if dry_run:
        # Dry-run cannot inspect simulator inventory; return empty to keep flow predictable.
        return []

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"Unable to parse simulator list JSON: {error}") from error

    devices: list[SimDevice] = []
    for runtime, runtime_devices in payload.get("devices", {}).items():
        for item in runtime_devices:
            if not item.get("isAvailable", False):
                continue
            devices.append(
                SimDevice(
                    name=item.get("name", "Unknown"),
                    udid=item.get("udid", ""),
                    state=item.get("state", "Unknown"),
                    runtime=runtime,
                )
            )

    if not devices:
        raise SystemExit("No available iOS simulators found. Open Xcode and install an iOS Simulator runtime.")

    return devices


def pick_newest(candidates: Iterable[SimDevice]) -> SimDevice:
    pool = list(candidates)
    if not pool:
        raise SystemExit("No matching simulator found.")
    pool.sort(key=lambda device: runtime_sort_key(device.runtime), reverse=True)
    return pool[0]


def select_device(
    devices: list[SimDevice],
    *,
    device_name: str | None,
    device_udid: str | None,
    dry_run: bool,
) -> SimDevice:
    if dry_run:
        return SimDevice(name=device_name or "dry-run-device", udid=device_udid or "dry-run-udid", state="Shutdown", runtime="iOS")

    if device_udid:
        for device in devices:
            if device.udid.lower() == device_udid.lower():
                return device
        raise SystemExit(f"Simulator with udid '{device_udid}' is not available.")

    if device_name:
        exact = [device for device in devices if device.name.lower() == device_name.lower()]
        if exact:
            return pick_newest(exact)
        partial = [device for device in devices if device_name.lower() in device.name.lower()]
        if partial:
            return pick_newest(partial)
        raise SystemExit(f"Simulator with name '{device_name}' is not available.")

    booted_iphones = [device for device in devices if device.state == "Booted" and "iphone" in device.name.lower()]
    if booted_iphones:
        return pick_newest(booted_iphones)

    booted_any = [device for device in devices if device.state == "Booted"]
    if booted_any:
        return pick_newest(booted_any)

    iphones = [device for device in devices if "iphone" in device.name.lower()]
    if iphones:
        return pick_newest(iphones)

    return pick_newest(devices)


def list_running_flutter_runs(dry_run: bool) -> list[str]:
    if dry_run:
        return []

    result = run_command(["ps", "-axo", "pid=,command="], check=True, dry_run=False, capture_output=True)
    running: list[str] = []
    for line in result.stdout.splitlines():
        command = line.strip()
        is_flutter_controller = (
            "flutter run" in command
            or ("flutter_tools.snapshot" in command and re.search(r"\brun\b", command))
        )
        is_running_app = "Runner.app/Runner" in command
        if not (is_flutter_controller or is_running_app):
            continue
        if "run_flutter_ios_debug.py" in command:
            continue
        running.append(command)
    return running


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Boot an iOS simulator and run a Flutter project in debug mode."
    )
    parser.add_argument(
        "--project",
        default=".",
        help="Path to Flutter project (default: current directory).",
    )
    parser.add_argument(
        "--device-name",
        help="Preferred simulator name (exact or partial match), e.g. 'iPhone 16 Pro'.",
    )
    parser.add_argument(
        "--device-udid",
        help="Preferred simulator UDID.",
    )
    parser.add_argument(
        "--target",
        default="lib/main.dart",
        help="Flutter entrypoint passed to --target (default: lib/main.dart).",
    )
    parser.add_argument(
        "--flavor",
        help="Optional Flutter flavor.",
    )
    parser.add_argument(
        "--dart-define",
        action="append",
        default=[],
        help="Repeatable flutter --dart-define value, e.g. KEY=VALUE.",
    )
    parser.add_argument(
        "--no-pub-get",
        action="store_true",
        help="Skip `flutter pub get` before running the app.",
    )
    parser.add_argument(
        "--allow-duplicate-run",
        action="store_true",
        help="Allow launch even when another `flutter run` process is active.",
    )
    parser.add_argument(
        "--no-wait-for-login",
        action="store_true",
        help="Do not pause after app launch for manual user login confirmation.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print planned commands without executing them.",
    )
    parser.add_argument(
        "flutter_args",
        nargs=argparse.REMAINDER,
        help="Extra arguments forwarded to flutter run after `--`.",
    )
    return parser.parse_args()


def run_flutter_with_optional_login_wait(
    flutter_run_cmd: list[str],
    *,
    project_dir: Path,
    wait_for_login: bool,
) -> int:
    cmd_display = shlex.join(flutter_run_cmd)
    print(f"+ (cd {project_dir} && {cmd_display})")

    # Keep the login prompt's TTY exclusively in the parent. Flutter's control
    # channel is intentionally detached here; a later owner-aware attach/reload
    # workflow controls the live session without racing `input()`.
    process = subprocess.Popen(
        flutter_run_cmd,
        cwd=str(project_dir),
        stdin=subprocess.DEVNULL,
        text=True,
    )

    def stop_process() -> None:
        if process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    try:
        if wait_for_login:
            if not sys.stdin.isatty():
                print("Cannot pause for login without an interactive TTY.")
                print("Run this script in an interactive terminal, or pass --no-wait-for-login.")
                stop_process()
                return 3

            print("")
            print("Action required: log in to the app on Simulator.")
            input("Press Enter when login is completed...")
            print("Login confirmed. Continuing debug session.")

        return process.wait()
    except KeyboardInterrupt:
        stop_process()
        return 130
    except BaseException:
        stop_process()
        raise


def main() -> int:
    if sys.platform != "darwin":
        raise SystemExit("This script supports iOS simulator workflows on macOS only.")

    args = parse_args()
    project_dir = Path(args.project).expanduser().resolve()

    if not project_dir.exists():
        raise SystemExit(f"Project path does not exist: {project_dir}")
    if not (project_dir / "pubspec.yaml").exists():
        raise SystemExit(f"Not a Flutter project (missing pubspec.yaml): {project_dir}")

    ensure_tools()

    running = list_running_flutter_runs(args.dry_run)
    if running and not args.allow_duplicate_run:
        print("Detected running `flutter run` processes. Reuse existing run or pass --allow-duplicate-run:")
        for process in running:
            print(f"  {process}")
        return 2

    run_command(["open", "-a", "Simulator"], dry_run=args.dry_run)

    devices = load_sim_devices(args.dry_run)
    device = select_device(
        devices,
        device_name=args.device_name,
        device_udid=args.device_udid,
        dry_run=args.dry_run,
    )
    print(f"Selected simulator: {device.name} ({device.udid}) [{device.state}]")

    if device.state != "Booted":
        run_command(["xcrun", "simctl", "boot", device.udid], check=False, dry_run=args.dry_run)
    run_command(["xcrun", "simctl", "bootstatus", device.udid, "-b"], dry_run=args.dry_run)

    if not args.no_pub_get:
        run_command(["flutter", "pub", "get"], cwd=project_dir, dry_run=args.dry_run)

    forwarded = list(args.flutter_args)
    if forwarded and forwarded[0] == "--":
        forwarded = forwarded[1:]

    flutter_run_cmd = ["flutter", "run", "-d", device.udid, "--debug"]
    if args.target:
        flutter_run_cmd.extend(["--target", args.target])
    if args.flavor:
        flutter_run_cmd.extend(["--flavor", args.flavor])
    for dart_define in args.dart_define:
        flutter_run_cmd.extend(["--dart-define", dart_define])
    flutter_run_cmd.extend(forwarded)

    if args.dry_run:
        run_result = run_command(flutter_run_cmd, cwd=project_dir, check=False, dry_run=True)
        return run_result.returncode

    return run_flutter_with_optional_login_wait(
        flutter_run_cmd,
        project_dir=project_dir,
        wait_for_login=not args.no_wait_for_login,
    )


if __name__ == "__main__":
    raise SystemExit(main())
