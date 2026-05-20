import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import type { CodexOrchestratorConfig } from '../config/schema.js';

const guardedTools = ['adb', 'emulator', 'flutter', 'xcrun'] as const;

export async function ensureMobileDeviceGuardBin(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
}): Promise<string> {
  const binDir = join(input.targetRoot, input.config.runner.stateDir, 'mobile-device-guard', 'bin');
  await mkdir(binDir, { recursive: true });
  await Promise.all(guardedTools.map((tool) => writeGuardWrapper(join(binDir, tool), tool)));
  return binDir;
}

export function prependPath(pathValue: string | undefined, entry: string): string {
  return pathValue ? `${entry}${delimiter}${pathValue}` : entry;
}

async function writeGuardWrapper(path: string, tool: typeof guardedTools[number]): Promise<void> {
  await writeFile(path, guardWrapperScript(tool), 'utf8');
  await chmod(path, 0o755);
}

function guardWrapperScript(tool: typeof guardedTools[number]): string {
  return `#!/usr/bin/env bash
set -euo pipefail

tool="${tool}"
guard_dir="$(cd "$(dirname "$0")" && pwd)"

blocked=0
case "$tool" in
  adb|emulator)
    blocked=1
    ;;
  flutter)
    case "\${1:-}" in
      run|drive|attach|install|screenshot)
        blocked=1
        ;;
    esac
    ;;
  xcrun)
    if [[ "\${1:-}" == "simctl" ]]; then
      blocked=1
    fi
    ;;
esac

if [[ "\${CODEX_ORCHESTRATOR_ALLOW_MOBILE_DEVICE_CONTROL:-}" != "1" && "$blocked" == "1" ]]; then
  printf "%s\\n" "Mobile device/emulator control is runner-owned. Child Codex must not run $tool here; use the runner-owned mobile visual proof command instead." >&2
  exit 126
fi

IFS=':' read -r -a path_entries <<< "\${PATH:-}"
for entry in "\${path_entries[@]}"; do
  if [[ -z "$entry" || "$entry" == "$guard_dir" ]]; then
    continue
  fi
  candidate="$entry/$tool"
  if [[ -x "$candidate" ]]; then
    exec "$candidate" "$@"
  fi
done

printf "%s\\n" "$tool: command not found outside Codex mobile device guard" >&2
exit 127
`;
}
