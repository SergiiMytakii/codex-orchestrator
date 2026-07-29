import { posix } from 'node:path';

const MAX_ISSUE_CHECKS = 32;
const ISSUE_CHECK_ID_PREFIX = 'issue-verification-';

export class InvalidIssueCheckPolicyError extends Error {}

export class CheckProcessQuiescenceError extends Error {
  constructor(readonly processGroupId: number) {
    super(`Check process group ${processGroupId} remained alive after termination.`);
  }
}

export interface IssueCheckInvocation {
  file: 'npm';
  args: string[];
}

export interface ResolvedIssueCheckPolicy {
  source: 'issue' | 'configured';
  checks: Record<string, string>;
}

export function resolveIssueCheckPolicy(
  issueBody: string,
  configuredFallback: Record<string, string>,
): ResolvedIssueCheckPolicy {
  const section = findVerificationSection(issueBody);
  if (!section) return { source: 'configured', checks: configuredFallback };
  const commands = parseVerificationCommands(section);
  return {
    source: 'issue',
    checks: Object.fromEntries(commands.map((command, index) => [
      `${ISSUE_CHECK_ID_PREFIX}${String(index + 1).padStart(3, '0')}`,
      command,
    ])),
  };
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

function findVerificationSection(issueBody: string): string[] | undefined {
  const lines = issueBody.split(/\r?\n/u);
  const headings: number[] = [];
  let fence: { delimiter: string; length: number } | undefined;
  let inComment = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (inComment) {
      if (trimmed.includes('-->')) inComment = false;
      continue;
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) inComment = true;
      continue;
    }
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = { delimiter: marker[0]!, length: marker.length };
      else if (marker[0] === fence.delimiter && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence || /^>/u.test(trimmed)) continue;
    if (/^(?:#{1,6}\s+)?verification:?\s*$/iu.test(trimmed)) headings.push(index);
  }
  if (headings.length === 0) return undefined;
  if (headings.length !== 1) invalid('contains multiple Verification sections');

  const section: string[] = [];
  for (const line of lines.slice(headings[0]! + 1)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/u.test(trimmed) || /^[A-Za-z][A-Za-z0-9 _-]*:\s*$/u.test(trimmed)) break;
    if (trimmed.length > 0) section.push(trimmed);
  }
  return section;
}

function parseVerificationCommands(lines: string[]): string[] {
  if (lines.length === 0) invalid('has no commands');
  const commands: string[] = [];
  for (const line of lines) {
    const match = line.match(/^[-*]\s+(.+?)\s*$/u);
    if (!match) invalid('must contain only command bullets');
    const command = unwrapInlineCode(match[1]!.trim());
    parseIssueCheckInvocation(command);
    if (commands.includes(command)) invalid('contains duplicate commands');
    commands.push(command);
    if (commands.length > MAX_ISSUE_CHECKS) invalid('exceeds 32 commands');
  }
  return commands;
}

function unwrapInlineCode(value: string): string {
  if (!value.startsWith('`') && !value.endsWith('`')) return value;
  if (!(value.startsWith('`') && value.endsWith('`')) || value.length <= 2 || value.slice(1, -1).includes('`')) {
    invalid('has malformed inline code');
  }
  return value.slice(1, -1).trim();
}

function isRepositoryRelativePath(value: string): boolean {
  return value === posix.normalize(value) && value !== '.' && !value.startsWith('/') && !value.startsWith('../');
}

function invalid(reason: string): never {
  throw new InvalidIssueCheckPolicyError(`Issue Verification ${reason}.`);
}
