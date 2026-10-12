import { posix } from 'node:path';

export class InvalidIssueCheckPolicyError extends Error {}

/** Host Flutter prerequisites failed; implementation retries cannot repair them. */
export class FlutterCheckEnvironmentError extends Error {}

export class CheckProcessQuiescenceError extends Error {
  constructor(readonly processGroupId: number) {
    super(`Check process group ${processGroupId} remained alive after termination.`);
  }
}

export interface IssueCheckInvocation {
  file: string;
  args: string[];
}

export function parseIssueCheckInvocation(command: string): IssueCheckInvocation {
  if (command.length === 0 || /[;&|<>`'"\\$\r\n]/u.test(command)) invalid('contains unsupported shell syntax');
  const tokens = command.split(/\s+/u);
  if (tokens.some((token) => !/^[A-Za-z0-9_./:@%+=[\],-]+$/u.test(token))) invalid('contains an unsupported token');
  if (tokens.shift() !== 'npm') invalid('must invoke npm');

  const args: string[] = [];
  if (tokens[0] === '--prefix') {
    args.push(tokens.shift()!);
    const prefix = tokens.shift();
    if (!prefix || !isRepositoryRelativePath(prefix)) invalid('has an invalid npm prefix');
    args.push(prefix);
  }
  const operation = tokens.shift();
  if (operation === 'test') args.push(operation);
  else if (operation === 'run') {
    const script = tokens.shift();
    if (!script || script.startsWith('-')) invalid('must name an npm script');
    args.push(operation, script);
  } else invalid('must use npm test or npm run');
  args.push(...tokens);
  return { file: 'npm', args };
}

function isRepositoryRelativePath(value: string): boolean {
  return value === posix.normalize(value) && value !== '.' && !value.startsWith('/') && !value.startsWith('../');
}

function invalid(reason: string): never {
  throw new InvalidIssueCheckPolicyError(`Issue Verification ${reason}.`);
}
