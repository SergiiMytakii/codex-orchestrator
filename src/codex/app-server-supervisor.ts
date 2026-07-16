import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

interface StartCommand {
  op: 'start';
  token: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export async function runAppServerSupervisor(controlFd = 3): Promise<void> {
  const controlInput = createReadStream('', { fd: controlFd, autoClose: false });
  const controlOutput = createWriteStream('', { fd: controlFd, autoClose: false });
  const lines = createInterface({ input: controlInput, crlfDelay: Infinity });
  let appServer: ChildProcess | undefined;
  let started = false;
  const deadline = setTimeout(() => process.exit(124), 10_000);
  deadline.unref();

  const stop = () => {
    if (appServer && appServer.exitCode === null) appServer.kill('SIGTERM');
    setTimeout(() => {
      if (appServer && appServer.exitCode === null) appServer.kill('SIGKILL');
      process.exit(0);
    }, 1_000).unref();
  };
  controlInput.on('close', stop);
  controlInput.on('error', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  lines.on('line', (line) => {
    if (started) return;
    let command: StartCommand;
    try {
      command = JSON.parse(line) as StartCommand;
      if (command.op !== 'start' || !command.token || !command.command || !Array.isArray(command.args)) throw new Error('invalid');
    } catch {
      controlOutput.write(`${JSON.stringify({ op: 'error', error: 'orchestrator-supervisor-start-invalid' })}\n`);
      stop();
      return;
    }
    started = true;
    clearTimeout(deadline);
    appServer = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    process.stdin.pipe(appServer.stdin!);
    appServer.stdout!.pipe(process.stdout);
    appServer.stderr!.pipe(process.stderr);
    appServer.once('spawn', () => {
      controlOutput.write(`${JSON.stringify({ op: 'running', token: command.token, appServerPid: appServer?.pid })}\n`);
    });
    appServer.once('error', (error) => {
      controlOutput.write(`${JSON.stringify({ op: 'error', token: command.token, error: error.message })}\n`);
      process.exitCode = 1;
    });
    appServer.once('close', (code, signal) => {
      controlOutput.write(`${JSON.stringify({ op: 'exit', token: command.token, code, signal })}\n`);
      process.exit(code ?? 1);
    });
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  void runAppServerSupervisor().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
