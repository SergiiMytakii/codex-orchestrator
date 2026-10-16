#!/usr/bin/env python3

import argparse
import re
import shutil
import subprocess
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare iOS simulator screenshots against an expected image using RMSE."
    )
    parser.add_argument("--expected", required=True, help="Path to expected screenshot.")
    parser.add_argument("--actual", required=True, help="Path to actual screenshot.")
    parser.add_argument("--diff-out", required=True, help="Path to write visual diff image.")
    parser.add_argument(
        "--rmse-threshold",
        type=float,
        default=0.03,
        help="Maximum allowed normalized RMSE difference in [0, 1]. Default: 0.03",
    )
    return parser.parse_args()


def parse_rmse(stderr_text: str) -> float:
    match = re.search(r"\(([-+0-9.eE]+)\)", stderr_text)
    if match:
        return float(match.group(1))

    match = re.search(r"([-+0-9.eE]+)", stderr_text)
    if match:
        return float(match.group(1))

    raise ValueError(f"Unable to parse RMSE from output: {stderr_text.strip()}")


def main() -> int:
    args = parse_args()

    expected = Path(args.expected).expanduser().resolve()
    actual = Path(args.actual).expanduser().resolve()
    diff_out = Path(args.diff_out).expanduser().resolve()

    if not expected.exists():
        raise SystemExit(f"Expected image does not exist: {expected}")
    if not actual.exists():
        raise SystemExit(f"Actual image does not exist: {actual}")
    if args.rmse_threshold < 0 or args.rmse_threshold > 1:
        raise SystemExit("rmse-threshold must be in [0, 1].")
    if shutil.which("magick") is None:
        raise SystemExit("ImageMagick is required (`magick` command not found).")

    diff_out.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        "magick",
        "compare",
        "-metric",
        "RMSE",
        str(expected),
        str(actual),
        str(diff_out),
    ]

    proc = subprocess.run(cmd, text=True, capture_output=True)
    metric_output = f"{proc.stderr}\n{proc.stdout}".strip()
    rmse_value = parse_rmse(metric_output)

    passed = rmse_value <= args.rmse_threshold
    status = "PASS" if passed else "FAIL"

    print(f"Status: {status}")
    print(f"Expected: {expected}")
    print(f"Actual:   {actual}")
    print(f"Diff:     {diff_out}")
    print(f"RMSE:     {rmse_value:.6f}")
    print(f"Threshold:{args.rmse_threshold:.6f}")

    if passed:
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
