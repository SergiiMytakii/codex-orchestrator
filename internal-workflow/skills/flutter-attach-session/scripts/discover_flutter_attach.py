#!/usr/bin/env python3

import argparse
import ctypes
import ctypes.util
import json
import os
import shlex
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlparse, urlunparse


@dataclass
class Device:
    udid: str
    name: str
    state: str
    runtime: str


@dataclass
class FlutterRunSession:
    pid: int
    ppid: int
    elapsed_seconds: int
    cwd: str | None
    device_id: str | None
    target: str | None
    parent_command: str | None
    command: str
    argv: list[str] | None = None


@dataclass
class DevelopmentService:
    pid: int
    ppid: int
    elapsed_seconds: int
    cwd: str | None
    vm_service_uri: str
    command: str


@dataclass
class AdbForward:
    device_id: str
    host_port: int
    device_port: int


def is_executable_file(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def parse_fvm_version(project: str | None) -> str | None:
    if not project:
        return None

    project_path = Path(project).expanduser()
    fvmrc = project_path / ".fvmrc"
    if fvmrc.is_file():
        version = fvmrc.read_text().strip()
        if version:
            return version

    fvm_config = project_path / ".fvm" / "fvm_config.json"
    if fvm_config.is_file():
        try:
            payload = json.loads(fvm_config.read_text())
        except json.JSONDecodeError:
            return None
        version = payload.get("flutterSdkVersion")
        if isinstance(version, str) and version.strip():
            return version.strip()

    return None


def version_sort_key(path: Path) -> tuple:
    parts: list[tuple[int, int | str]] = []
    for chunk in path.parent.parent.name.replace("-", ".").split("."):
        try:
            parts.append((0, int(chunk)))
        except ValueError:
            parts.append((1, chunk))
    return tuple(parts)


def resolve_flutter_bin(project: str | None, explicit_flutter_bin: str | None) -> str:
    candidates: list[Path] = []

    if explicit_flutter_bin:
        candidates.append(Path(explicit_flutter_bin).expanduser())

    env_flutter_bin = os.environ.get("FLUTTER_BIN")
    if env_flutter_bin:
        candidates.append(Path(env_flutter_bin).expanduser())

    if project:
        project_path = Path(project).expanduser()
        candidates.append(project_path / ".fvm" / "flutter_sdk" / "bin" / "flutter")
        fvm_version = parse_fvm_version(project)
        if fvm_version:
            candidates.append(Path.home() / "fvm" / "versions" / fvm_version / "bin" / "flutter")

    path_flutter = shutil.which("flutter")
    if path_flutter:
        candidates.append(Path(path_flutter))

    fvm_versions = Path.home() / "fvm" / "versions"
    if fvm_versions.is_dir():
        candidates.extend(
            sorted(
                fvm_versions.glob("*/bin/flutter"),
                key=version_sort_key,
                reverse=True,
            )
        )

    for candidate in candidates:
        if is_executable_file(candidate):
            return str(candidate.resolve())

    raise SystemExit(
        "Could not resolve a Flutter binary. Pass --flutter-bin or set FLUTTER_BIN."
    )


def run_command(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=check)


def parse_elapsed_seconds(raw: str) -> int:
    text = raw.strip()
    if not text:
        return 0

    days = 0
    if "-" in text:
        day_part, text = text.split("-", 1)
        days = int(day_part)

    parts = [int(part) for part in text.split(":")]
    if len(parts) == 3:
        hours, minutes, seconds = parts
    elif len(parts) == 2:
        hours = 0
        minutes, seconds = parts
    elif len(parts) == 1:
        hours = 0
        minutes = 0
        seconds = parts[0]
    else:
        return 0

    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def safe_realpath(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return str(Path(value).expanduser().resolve())
    except OSError:
        return value


def read_process_cwd(pid: int) -> str | None:
    try:
        result = run_command(["lsof", "-a", "-d", "cwd", "-p", str(pid), "-Fn"], check=False)
    except FileNotFoundError:
        return None

    for line in result.stdout.splitlines():
        if line.startswith("n"):
            return line[1:]
    return None


def parse_procargs2(data: bytes) -> list[str] | None:
    if len(data) < 4:
        return None
    argc = int.from_bytes(data[:4], byteorder=sys.byteorder, signed=True)
    if argc <= 0:
        return None

    cursor = 4
    executable_end = data.find(b"\0", cursor)
    if executable_end < 0:
        return None
    cursor = executable_end
    while cursor < len(data) and data[cursor] == 0:
        cursor += 1

    argv: list[str] = []
    while cursor < len(data) and len(argv) < argc:
        value_end = data.find(b"\0", cursor)
        if value_end < 0:
            return None
        argv.append(data[cursor:value_end].decode(errors="surrogateescape"))
        cursor = value_end + 1
    return argv if len(argv) == argc else None


def read_process_argv(pid: int) -> list[str] | None:
    if sys.platform != "darwin":
        return None

    libc_path = ctypes.util.find_library("c")
    libc = ctypes.CDLL(libc_path or None, use_errno=True)
    sysctl = libc.sysctl
    sysctl.argtypes = [
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_uint,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_size_t),
        ctypes.c_void_p,
        ctypes.c_size_t,
    ]
    sysctl.restype = ctypes.c_int

    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2, pid
    size = ctypes.c_size_t()
    if sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or size.value == 0:
        return None

    buffer = ctypes.create_string_buffer(size.value)
    if sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        return None
    return parse_procargs2(buffer.raw[: size.value])


def parse_arg_value(tokens: list[str], *keys: str) -> str | None:
    for index, token in enumerate(tokens):
        for key in keys:
            if token == key and index + 1 < len(tokens):
                return tokens[index + 1]
            if token.startswith(f"{key}="):
                return token.split("=", 1)[1]
    return None


def flutter_run_arguments(argv: list[str]) -> list[str]:
    try:
        run_index = argv.index("run")
    except ValueError:
        return argv
    return argv[run_index + 1 :]


def resolve_run_target(argv: list[str], cwd: str | None) -> str | None:
    tokens = flutter_run_arguments(argv)
    raw_target: str | None = None
    for index, token in enumerate(tokens):
        if token in {"--target", "-t"}:
            if (
                index + 1 >= len(tokens)
                or not tokens[index + 1]
                or tokens[index + 1].startswith("-")
            ):
                raise SystemExit(
                    "Refusing flutter attach because the selected run's compile identity "
                    f"contains {token} without a value."
                )
            raw_target = tokens[index + 1]
            continue
        if token.startswith("--target="):
            raw_target = token.split("=", 1)[1]
            if not raw_target:
                raise SystemExit(
                    "Refusing flutter attach because the selected run's compile identity "
                    "contains --target without a value."
                )
            continue
        if token.startswith("-t") and not token.startswith("--") and token != "-t":
            raw_target = token[2:]
            if not raw_target:
                raise SystemExit(
                    "Refusing flutter attach because the selected run's compile identity "
                    "contains -t without a value."
                )

    if raw_target is None:
        if tokens and not tokens[0].startswith("-") and tokens[0].endswith(".dart"):
            raw_target = tokens[0]
        elif any(not token.startswith("-") and token.endswith(".dart") for token in tokens):
            raise SystemExit(
                "Refusing flutter attach because the selected run's compile identity "
                "contains an ambiguous positional Dart target."
            )

    if raw_target:
        target = Path(raw_target).expanduser()
        if not target.is_absolute():
            if not cwd:
                return None
            target = Path(cwd) / target
        return safe_realpath(str(target))
    if cwd:
        return safe_realpath(str(Path(cwd) / "lib" / "main.dart"))
    return None


def build_compile_identity_args(run: FlutterRunSession) -> list[str]:
    if not run.target:
        raise SystemExit(
            "Refusing flutter attach because the selected run's compile identity "
            "has no target. Preserve the live app and use a fresh authorized launch instead."
        )

    if run.argv is None:
        raise SystemExit(
            "Refusing flutter attach because the selected run's compile identity "
            "argv could not be read without losing argument boundaries."
        )
    tokens = flutter_run_arguments(run.argv)

    compile_args = ["--target", run.target]
    repeatable_options = (
        ("--dart-define", "--dart-define"),
        ("--dart-defines", "--dart-define"),
        ("--dart-define-from-file", "--dart-define-from-file"),
    )
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token == "-D":
            if index + 1 >= len(tokens) or tokens[index + 1].startswith("-"):
                raise SystemExit(
                    "Refusing flutter attach because the selected run's compile identity "
                    "contains -D without a value."
                )
            value = tokens[index + 1]
            if "=" not in value or value.startswith("="):
                raise SystemExit(
                    "Refusing flutter attach because the selected run's compile identity "
                    "contains -D without a valid key=value."
                )
            compile_args.extend(["--dart-define", value])
            index += 2
            continue
        if token.startswith("-D") and len(token) > 2:
            value = token[2:]
            if "=" not in value or value.startswith("="):
                raise SystemExit(
                    "Refusing flutter attach because the selected run's compile identity "
                    "contains -D without a valid key=value."
                )
            compile_args.extend(["--dart-define", value])
            index += 1
            continue
        matched = False
        for source_option, attach_option in repeatable_options:
            if token == source_option:
                if (
                    index + 1 >= len(tokens)
                    or not tokens[index + 1]
                    or tokens[index + 1].startswith("-")
                ):
                    raise SystemExit(
                        "Refusing flutter attach because the selected run's compile identity "
                        f"contains {source_option} without a value."
                    )
                value = tokens[index + 1]
                if attach_option == "--dart-define" and (
                    "=" not in value or value.startswith("=")
                ):
                    raise SystemExit(
                        "Refusing flutter attach because the selected run's compile identity "
                        "contains --dart-define without a valid key=value."
                    )
                compile_args.extend([attach_option, value])
                index += 2
                matched = True
                break
            if token.startswith(f"{source_option}="):
                value = token.split("=", 1)[1]
                if not value:
                    raise SystemExit(
                        "Refusing flutter attach because the selected run's compile identity "
                        f"contains {source_option} without a value."
                    )
                if attach_option == "--dart-define" and (
                    "=" not in value or value.startswith("=")
                ):
                    raise SystemExit(
                        "Refusing flutter attach because the selected run's compile identity "
                        "contains --dart-define without a valid key=value."
                    )
                compile_args.extend([attach_option, value])
                index += 1
                matched = True
                break
        if not matched:
            index += 1

    return compile_args


def redact_attach_command_tokens(command: list[str]) -> list[str]:
    redacted = list(command)
    index = 0
    while index < len(redacted):
        token = redacted[index]
        if token == "--dart-define" and index + 1 < len(redacted):
            value = redacted[index + 1]
            key = value.split("=", 1)[0] if "=" in value else "DEFINE"
            redacted[index + 1] = f"{key}=[REDACTED]"
            index += 2
            continue
        if token == "--dart-define-from-file" and index + 1 < len(redacted):
            redacted[index + 1] = "[REDACTED_PATH]"
            index += 2
            continue
        index += 1
    return redacted


def redact_attach_command(command: list[str]) -> str:
    return shlex.join(redact_attach_command_tokens(command))


def sanitize_candidate_for_display(candidate: dict) -> dict:
    public = dict(candidate)
    run = dict(public.get("run") or {})
    if "command" in run:
        run["command"] = "[REDACTED: process command contains compile configuration]"
    if "parent_command" in run:
        run["parent_command"] = "[REDACTED: parent command may contain compile configuration]"
    public["run"] = run

    attach_command = list(public.get("attach_command") or [])
    public["attach_command"] = redact_attach_command_tokens(attach_command)
    public["attach_command_shell"] = redact_attach_command(attach_command)
    public["command_values_redacted"] = True
    return public


def load_simulator_devices() -> dict[str, Device]:
    try:
        result = run_command(["xcrun", "simctl", "list", "devices", "--json"])
        payload = json.loads(result.stdout)
    except (FileNotFoundError, subprocess.CalledProcessError, json.JSONDecodeError):
        return {}

    devices: dict[str, Device] = {}

    for runtime, runtime_devices in payload.get("devices", {}).items():
        for item in runtime_devices:
            if not item.get("isAvailable", False):
                continue
            device = Device(
                udid=item.get("udid", ""),
                name=item.get("name", "Unknown"),
                state=item.get("state", "Unknown"),
                runtime=runtime,
            )
            devices[device.udid] = device

    return devices


def load_process_table() -> tuple[list[FlutterRunSession], list[DevelopmentService]]:
    result = run_command(["ps", "-axo", "pid=,ppid=,etime=,command="])
    flutter_runs: list[FlutterRunSession] = []
    dev_services: list[DevelopmentService] = []
    process_rows: list[tuple[int, int, int, str]] = []
    command_by_pid: dict[int, str] = {}

    for raw_line in result.stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        parts = line.split(None, 3)
        if len(parts) < 4:
            continue

        pid = int(parts[0])
        ppid = int(parts[1])
        elapsed = parse_elapsed_seconds(parts[2])
        command = parts[3]
        process_rows.append((pid, ppid, elapsed, command))
        command_by_pid[pid] = command

    for pid, ppid, elapsed, command in process_rows:
        is_flutter_run = "flutter_tools.snapshot" in command and " run " in f" {command} " and " attach " not in f" {command} "
        is_dev_service = "development-service" in command
        if not is_flutter_run and not is_dev_service:
            continue

        process_argv = read_process_argv(pid)
        try:
            fallback_tokens = shlex.split(command)
        except ValueError:
            fallback_tokens = command.split()
        tokens = process_argv or fallback_tokens
        cwd = read_process_cwd(pid)

        if is_flutter_run:
            flutter_runs.append(
                FlutterRunSession(
                    pid=pid,
                    ppid=ppid,
                    elapsed_seconds=elapsed,
                    cwd=safe_realpath(cwd),
                    device_id=parse_arg_value(tokens, "-d", "--device-id"),
                    target=resolve_run_target(process_argv, cwd) if process_argv else None,
                    parent_command=command_by_pid.get(ppid),
                    command=command,
                    argv=process_argv,
                )
            )
            continue

        if is_dev_service:
            vm_service_uri = parse_arg_value(tokens, "--vm-service-uri")
            if not vm_service_uri:
                continue
            dev_services.append(
                DevelopmentService(
                    pid=pid,
                    ppid=ppid,
                    elapsed_seconds=elapsed,
                    cwd=safe_realpath(cwd),
                    vm_service_uri=vm_service_uri,
                    command=command,
                )
            )

    return flutter_runs, dev_services


def load_adb_forwards(device_id: str | None) -> list[AdbForward]:
    if not device_id:
        return []

    try:
        result = run_command(["adb", "-s", device_id, "forward", "--list"], check=False)
    except FileNotFoundError:
        return []

    if result.returncode != 0:
        return []

    forwards: list[AdbForward] = []
    for raw_line in result.stdout.splitlines():
        parts = raw_line.split()
        if len(parts) != 3:
            continue

        serial, local, remote = parts
        if serial != device_id:
            continue
        if not local.startswith("tcp:") or not remote.startswith("tcp:"):
            continue

        try:
            forwards.append(
                AdbForward(
                    device_id=serial,
                    host_port=int(local.split(":", 1)[1]),
                    device_port=int(remote.split(":", 1)[1]),
                )
            )
        except ValueError:
            continue

    return forwards


def looks_like_project_match(project: str | None, candidate: FlutterRunSession) -> bool:
    if not project:
        return True

    project_path = Path(safe_realpath(project) or project).expanduser().resolve()
    for candidate_path in (candidate.cwd, candidate.target):
        if not candidate_path:
            continue
        try:
            Path(candidate_path).expanduser().resolve().relative_to(project_path)
            return True
        except ValueError:
            continue
    return False


def matches_requested_device(
    run: FlutterRunSession,
    *,
    devices: dict[str, Device],
    device_udid: str | None,
    device_name: str | None,
) -> bool:
    if device_udid and run.device_id != device_udid:
        return False
    if not device_name:
        return True

    device = devices.get(run.device_id or "")
    if not device:
        return False
    requested = device_name.lower()
    actual = device.name.lower()
    return actual == requested


def score_run(
    run: FlutterRunSession,
    *,
    devices: dict[str, Device],
    project: str | None,
    device_udid: str | None,
    device_name: str | None,
) -> int:
    score = 0

    if project and looks_like_project_match(project, run):
        score += 120
    elif project:
        score -= 120

    if device_udid and run.device_id == device_udid:
        score += 120
    elif device_udid:
        score -= 120

    if device_name:
        name = device_name.lower()
        actual = devices.get(run.device_id or "")
        if actual and (actual.name.lower() == name or name in actual.name.lower()):
            score += 80
        else:
            score -= 80

    actual_device = devices.get(run.device_id or "")
    if actual_device and actual_device.state == "Booted":
        score += 40
    if actual_device and "iphone" in actual_device.name.lower():
        score += 15

    score += max(0, 30 - min(run.elapsed_seconds, 30))

    if run.cwd:
        score += 10
    if run.target:
        score += 10

    return score


def score_service_match(run: FlutterRunSession, service: DevelopmentService) -> int:
    score = 0

    if service.ppid == run.pid:
        score += 150
    if run.cwd and service.cwd and run.cwd == service.cwd:
        score += 120
    if run.target and service.cwd and run.target.startswith(service.cwd):
        score += 80

    time_gap = abs(run.elapsed_seconds - service.elapsed_seconds)
    score += max(0, 60 - min(time_gap, 60))

    return score


def pick_service(run: FlutterRunSession, services: list[DevelopmentService]) -> DevelopmentService | None:
    if not services:
        return None

    # A time-nearby service is not enough to identify the app. Require the
    # development service to be the direct child of the selected flutter run;
    # otherwise a second app can receive the pinned run's attach command.
    services = [service for service in services if service.ppid == run.pid]
    if len(services) != 1:
        return None

    ranked = sorted(
        ((score_service_match(run, service), service) for service in services),
        key=lambda item: item[0],
        reverse=True,
    )

    best_score, best_service = ranked[0]
    if best_score <= 0:
        return None
    return best_service


def resolve_debug_uri_for_attach(
    run: FlutterRunSession,
    service: DevelopmentService | None,
) -> tuple[str | None, dict | None]:
    if service is None:
        return None, None

    parsed = urlparse(service.vm_service_uri)
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.port is None:
        return service.vm_service_uri, {
            "source_uri": service.vm_service_uri,
            "resolved_uri": service.vm_service_uri,
            "reason": "not_loopback_or_no_port",
            "adb_forward": None,
        }

    for forward in load_adb_forwards(run.device_id):
        if forward.host_port != parsed.port:
            continue

        netloc = parsed.netloc.replace(str(parsed.port), str(forward.device_port), 1)
        resolved = urlunparse(parsed._replace(netloc=netloc))
        return resolved, {
            "source_uri": service.vm_service_uri,
            "resolved_uri": resolved,
            "reason": "adb_host_forward_resolved_to_device_port",
            "adb_forward": asdict(forward),
        }

    return service.vm_service_uri, {
        "source_uri": service.vm_service_uri,
        "resolved_uri": service.vm_service_uri,
        "reason": "no_matching_adb_forward",
        "adb_forward": None,
    }


def build_attach_command(
    run: FlutterRunSession,
    service: DevelopmentService | None,
    debug_uri: str | None,
    flutter_bin: str,
) -> list[str]:
    command = [flutter_bin, "attach"]
    command.extend(build_compile_identity_args(run))
    if run.device_id:
        command.extend(["--device-id", run.device_id])
    if service and debug_uri:
        command.extend(["--debug-uri", debug_uri])
    return command


def classify_owner(run: FlutterRunSession) -> dict:
    parent_command = run.parent_command or ""
    command = run.command
    is_machine_run = " --machine " in f" {command} "
    is_debug_adapter = "flutter_tools.snapshot" in parent_command and " debug_adapter" in parent_command
    if is_debug_adapter:
        owner_type = "ide_debug_adapter"
        attach_safe = False
        reason = (
            "The Flutter run is owned by an IDE debug adapter. Starting a second "
            "flutter attach client can compete with the IDE resident runner's "
            "DevFS and incremental compiler."
        )
    elif is_machine_run:
        owner_type = "machine_run"
        attach_safe = False
        reason = (
            "The Flutter run uses --machine. A second attach client could compete "
            "with the owning controller."
        )
    elif parent_command and any(shell in parent_command for shell in ("zsh", "bash", "fish", " sh ")):
        owner_type = "terminal_run"
        attach_safe = True
        reason = "The Flutter run looks like an interactive terminal session."
    else:
        owner_type = "unknown"
        attach_safe = False
        reason = (
            "The Flutter run owner is ambiguous. Refuse a second attach controller "
            "until the owning IDE, machine runner, or terminal is identified."
        )

    return {
        "type": owner_type,
        "attach_safe": attach_safe,
        "reason": reason,
    }


def format_candidate(
    run: FlutterRunSession,
    service: DevelopmentService | None,
    devices: dict[str, Device],
    flutter_bin: str,
) -> dict:
    device = devices.get(run.device_id or "")
    debug_uri, debug_uri_resolution = resolve_debug_uri_for_attach(run, service)
    attach_command = build_attach_command(run, service, debug_uri, flutter_bin)
    run_payload = asdict(run)
    run_payload.pop("argv", None)
    return {
        "run": run_payload,
        "device": asdict(device) if device else None,
        "development_service": asdict(service) if service else None,
        "debug_uri_resolution": debug_uri_resolution,
        "owner": classify_owner(run),
        "flutter_bin": flutter_bin,
        "attach_command": attach_command,
        "attach_command_shell": redact_attach_command(attach_command),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Discover a live Flutter debug session and print a safe flutter attach command."
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
    parser.add_argument("--json", action="store_true", help="Print JSON output.")
    parser.add_argument("--control-json", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    if sys.platform != "darwin":
        raise SystemExit("This helper currently targets macOS Flutter workflows.")

    args = parse_args()
    flutter_bin = resolve_flutter_bin(args.project, args.flutter_bin)
    devices = load_simulator_devices()
    flutter_runs, dev_services = load_process_table()

    if not flutter_runs:
        print("No running Flutter debug sessions found.", file=sys.stderr)
        return 2

    matching_runs = [
        run
        for run in flutter_runs
        if looks_like_project_match(args.project, run)
        and matches_requested_device(
            run,
            devices=devices,
            device_udid=args.device_udid,
            device_name=args.device_name,
        )
    ]
    if not matching_runs:
        print("No Flutter debug session matched the requested project/device.", file=sys.stderr)
        return 4

    ranked_runs = sorted(
        (
            (
                score_run(
                    run,
                    devices=devices,
                    project=args.project,
                    device_udid=args.device_udid,
                    device_name=args.device_name,
                ),
                run,
            )
            for run in matching_runs
        ),
        key=lambda item: item[0],
        reverse=True,
    )

    best_run = ranked_runs[0][1]
    best_service = pick_service(best_run, dev_services)
    if best_service is None:
        print(
            "Found a Flutter run process but could not match it to a development-service VM URI safely.",
            file=sys.stderr,
        )
        return 3

    best_candidate = format_candidate(best_run, best_service, devices, flutter_bin)

    if args.json or args.control_json:
        payload = {
            "selected": (
                best_candidate
                if args.control_json
                else sanitize_candidate_for_display(best_candidate)
            ),
            "candidates_found": len(matching_runs),
            "development_services_found": len(dev_services),
        }
        print(json.dumps(payload, indent=2))
        return 0

    device = best_candidate["device"]
    print("Selected Flutter session:")
    print(f"- pid: {best_run.pid}")
    print(f"- cwd: {best_run.cwd or 'unknown'}")
    print(f"- device: {device['name']} ({device['udid']})" if device else f"- device id: {best_run.device_id or 'unknown'}")
    print(f"- target: {best_run.target or 'unknown'}")
    print(f"- flutter: {flutter_bin}")
    print(f"- vm service: {best_service.vm_service_uri if best_service else 'not found'}")
    print("")
    print("Attach command:")
    print(best_candidate["attach_command_shell"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
