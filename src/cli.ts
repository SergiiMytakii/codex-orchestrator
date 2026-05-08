#!/usr/bin/env node

import { readPackageInfo } from './package-info.js';

const helpText = `codex-orchestrator

Usage:
  codex-orchestrator --help
  codex-orchestrator --version
  codex-orchestrator health

Commands:
  health       Run a no-op local health check.

Options:
  --help, -h      Show this help.
  --version, -v   Show package version.
`;

async function main(args: string[]): Promise<number> {
  const [command] = args;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(helpText);
    return 0;
  }

  if (command === '--version' || command === '-v') {
    const packageInfo = await readPackageInfo();
    process.stdout.write(`${packageInfo.name} ${packageInfo.version}\n`);
    return 0;
  }

  if (command === 'health') {
    process.stdout.write('codex-orchestrator health: ok\n');
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\nRun codex-orchestrator --help for usage.\n`);
  return 1;
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
