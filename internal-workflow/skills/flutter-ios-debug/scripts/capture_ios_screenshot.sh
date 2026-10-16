#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "" || "${2:-}" == "" ]]; then
  echo "Usage: capture_ios_screenshot.sh /absolute/or/relative/path.png [simulator-udid]" >&2
  exit 1
fi

out_path="$1"
device_id="$2"
mkdir -p "$(dirname "$out_path")"
xcrun simctl io "$device_id" screenshot "$out_path" >/dev/null
echo "$out_path"
