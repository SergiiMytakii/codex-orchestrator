#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  readFile,
  rm,
  writeFile,
  mkdtemp,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const REPO = 'SergiiMytakii/codex-orchestrator';
const RUNNER_ID = 'codex-orchestrator-local-self-improvement';
const DEFAULT_CWD = '/Users/serhiimytakii/Projects/codex-orchestrator';
const CODEX_COMMAND = '/Applications/Codex.app/Contents/Resources/codex';
const STALE_LOCK_MS = 12 * 60 * 60 * 1000;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function fingerprintCandidate(candidate) {
  return sha256({
    title: candidate.title,
    files: candidate.files,
    problem: candidate.problem,
    solution: candidate.solution,
    benefits: candidate.benefits,
    verification: candidate.verification,
    risk: candidate.risk,
    adrConflict: candidate.adrConflict,
  });
}

export function fingerprintFinding(finding) {
  return sha256({
    summary: finding.summary,
    evidence: finding.evidence,
    proposedFix: finding.proposedFix,
    sourceIssue: finding.sourceIssue,
    sourcePr: finding.sourcePr ?? null,
    findingFingerprint: finding.findingFingerprint,
  });
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

export function validateDiscoveryReport(report) {
  if (!report || report.status !== 'completed' || !Array.isArray(report.candidates)) {
    return { ok: false, reason: 'Discovery report must contain status completed and candidates array.' };
  }
  const valid = report.candidates.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    if (!nonEmptyString(candidate.title)) return false;
    if (!nonEmptyStringArray(candidate.files)) return false;
    if (!nonEmptyString(candidate.problem)) return false;
    if (!nonEmptyString(candidate.solution)) return false;
    if (!nonEmptyStringArray(candidate.benefits)) return false;
    if (!nonEmptyStringArray(candidate.verification)) return false;
    if (!nonEmptyString(candidate.risk)) return false;
    if (!nonEmptyString(candidate.adrConflict)) return false;
    if (candidate.adrConflict.trim().toLowerCase() !== 'none') return false;
    return true;
  });
  if (valid.length === 0) return { ok: false, reason: 'Discovery report has no valid candidates.' };
  return { ok: true, candidates: valid, residualRisks: report.residualRisks ?? [] };
}

export function validateReviewReport(report) {
  if (!report || report.status !== 'completed' || !Array.isArray(report.findings)) {
    return { ok: false, reason: 'Review report must contain status completed and findings array.' };
  }
  const valid = report.findings.filter((finding) => {
    if (!finding || typeof finding !== 'object') return false;
    if (!nonEmptyString(finding.summary)) return false;
    if (!nonEmptyString(finding.evidence)) return false;
    if (!nonEmptyString(finding.proposedFix)) return false;
    if (!Number.isInteger(Number(finding.sourceIssue))) return false;
    if (!nonEmptyString(finding.findingFingerprint)) return false;
    return true;
  });
  if (report.findings.length > 0 && valid.length === 0) {
    return { ok: false, reason: 'Review report has findings but none are valid.' };
  }
  return { ok: true, findings: valid.slice(0, 5), residualRisks: report.residualRisks ?? [] };
}

async function defaultExec(command, args = [], options = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = options.timeout
      ? setTimeout(() => {
        child.kill('SIGTERM');
        stderr += `\nTimed out after ${options.timeout} ms`;
      }, options.timeout)
      : null;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function parseJson(stdout, fallback) {
  const text = stdout && stdout.trim().length > 0 ? stdout : fallback;
  return JSON.parse(text || 'null');
}

function issueNumberFromUrl(value) {
  const match = String(value).match(/\/issues\/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean);
}

function isReviewEligible(issue) {
  const labels = labelsOf(issue);
  if (!labels.includes('self-improvement')) return false;
  if (labels.includes('agent:running') || labels.includes('agent:blocked')) return false;
  if (labels.includes('agent:review')) return true;
  if (issue.state === 'CLOSED' && Array.isArray(issue.closedByPullRequestsReferences) && issue.closedByPullRequestsReferences.length > 0) return true;
  if (Array.isArray(issue.closedByPullRequestsReferences) && issue.closedByPullRequestsReferences.length > 0) return true;
  return false;
}

function renderDiscoveryIssue(candidate, fingerprint, date) {
  return `## Self-improvement candidate

Problem:
${candidate.problem}

Solution:
${candidate.solution}

Files:
${candidate.files.map((file) => `- ${file}`).join('\n')}

Benefits:
${candidate.benefits.map((benefit) => `- ${benefit}`).join('\n')}

Verification:
${candidate.verification.map((item) => `- ${item}`).join('\n')}

Risk:
${candidate.risk}

ADR conflict:
${candidate.adrConflict}

Acceptance criteria:
- Implement the proposed architecture improvement with the smallest safe blast radius.
- Run the listed verification or document the blocker.
- Keep changes inside the files owned by the issue.

## codex-orchestrator metadata
- owner: local self-improvement runner
- candidate files: ${candidate.files.join(', ')}
- source-date: ${date}

self-improvement-runner-id:${RUNNER_ID}
source-candidate-fingerprint:${fingerprint}
source-date:${date}
`;
}

function renderFollowUpIssue(finding, fingerprint) {
  return `## Review finding

Summary:
${finding.summary}

Evidence:
${finding.evidence}

Proposed fix:
${finding.proposedFix}

self-improvement-runner-id:${RUNNER_ID}
source-issue:${finding.sourceIssue}
source-pr:${finding.sourcePr ?? 'none'}
finding-fingerprint:${fingerprint}
`;
}

function summarizeOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(0, 2000);
}

function createDailyPhaseResult(name, result = {}) {
  return { name, ...result };
}

function isDailyPhaseFailure(phase) {
  return phase?.status === 'failed';
}

function dailyPhaseExitCode(phases) {
  return phases.some(isDailyPhaseFailure) ? 1 : 0;
}

function renderDailyPhaseSummaryLine(phase) {
  const details = [
    phase.issueNumber ? `issue #${phase.issueNumber}` : '',
    phase.created?.length ? `created ${phase.created.length}` : '',
    phase.reused?.length ? `reused ${phase.reused.length}` : '',
    phase.reason ? phase.reason : '',
  ].filter(Boolean).join('; ');
  return `${phase.name}: ${phase.status}${details ? ` (${details})` : ''}`;
}

function renderDailyPhaseSummaryLines(phases) {
  return phases.map(renderDailyPhaseSummaryLine);
}

export const dailyPhase = Object.freeze({
  result: createDailyPhaseResult,
  failed: isDailyPhaseFailure,
  exitCode: dailyPhaseExitCode,
  summaryLine: renderDailyPhaseSummaryLine,
  summaryLines: renderDailyPhaseSummaryLines,
});

export function createRunner(options = {}) {
  const cwd = options.cwd ?? DEFAULT_CWD;
  const localDir = options.localDir ?? path.join(cwd, '.codex-orchestrator/local/self-improvement');
  const exec = options.exec ?? defaultExec;
  const now = options.now ?? (() => new Date());
  const hostname = options.hostname ?? (() => os.hostname());
  const pid = options.pid ?? process.pid;
  const isPidAlive = options.isPidAlive ?? ((targetPid) => {
    try {
      process.kill(targetPid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const codexCommand = options.codexCommand ?? CODEX_COMMAND;

  const paths = {
    cwd,
    localDir,
    state: path.join(localDir, 'state.json'),
    lock: path.join(localDir, 'lock'),
    prompts: path.join(localDir, 'prompts'),
    reports: path.join(localDir, 'reports'),
  };

  async function ensureDirs() {
    await mkdir(paths.localDir, { recursive: true });
    await mkdir(paths.prompts, { recursive: true });
    await mkdir(paths.reports, { recursive: true });
  }

  async function loadState() {
    try {
      return JSON.parse(await readFile(paths.state, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function saveState(state) {
    await ensureDirs();
    await writeFile(paths.state, `${JSON.stringify(state, null, 2)}\n`);
  }

  async function acquireLock() {
    await ensureDirs();
    try {
      await mkdir(paths.lock);
      await writeFile(path.join(paths.lock, 'lock.json'), JSON.stringify({
        pid,
        hostname: hostname(),
        timestamp: now().toISOString(),
      }, null, 2));
      return { ok: true };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let lock = null;
      try {
        lock = JSON.parse(await readFile(path.join(paths.lock, 'lock.json'), 'utf8'));
      } catch {
        throw new Error('active lock exists and cannot be inspected');
      }
      const age = now().getTime() - new Date(lock.timestamp).getTime();
      const sameHost = lock.hostname === hostname();
      const deadPid = !isPidAlive(Number(lock.pid));
      if (sameHost && deadPid && age > STALE_LOCK_MS) {
        await rm(paths.lock, { recursive: true, force: true });
        return acquireLock();
      }
      throw new Error('active lock exists');
    }
  }

  async function releaseLock() {
    await rm(paths.lock, { recursive: true, force: true });
  }

  async function preflight() {
    const repo = await exec('gh', ['repo', 'view', REPO, '--json', 'nameWithOwner'], { cwd });
    if (repo.code !== 0) return { ok: false, reason: `repo identity check failed: ${summarizeOutput(repo)}` };
    let repoJson;
    try {
      repoJson = parseJson(repo.stdout);
    } catch {
      return { ok: false, reason: 'repo identity check returned invalid JSON' };
    }
    if (repoJson?.nameWithOwner !== REPO) return { ok: false, reason: `repo identity mismatch: ${repoJson?.nameWithOwner ?? 'unknown'}` };

    const auth = await exec('gh', ['auth', 'status'], { cwd });
    if (auth.code !== 0) return { ok: false, reason: `gh auth status failed: ${summarizeOutput(auth)}` };

    const labels = await exec('gh', ['label', 'list', '--repo', REPO, '--limit', '1000', '--json', 'name'], { cwd });
    if (labels.code !== 0) return { ok: false, reason: `gh label list failed: ${summarizeOutput(labels)}` };
    let labelNames;
    try {
      labelNames = parseJson(labels.stdout).map((label) => label.name);
    } catch {
      return { ok: false, reason: 'label list returned invalid JSON' };
    }
    for (const required of ['agent:auto', 'agent:manual']) {
      if (!labelNames.includes(required)) return { ok: false, reason: `required label missing: ${required}` };
    }
    if (!labelNames.includes('self-improvement')) {
      const created = await exec('gh', [
        'label',
        'create',
        'self-improvement',
        '--repo',
        REPO,
        '--color',
        '5319E7',
        '--description',
        'Local codex-orchestrator self-improvement loop',
      ], { cwd });
      if (created.code !== 0) return { ok: false, reason: `self-improvement label create failed: ${summarizeOutput(created)}` };
    }
    return { ok: true };
  }

  async function runCodexJson({ phase, promptPath, contextText = '', reportPath }) {
    await ensureDirs();
    const resolvedReportPath = reportPath ?? path.join(paths.reports, `${phase}-${Date.now()}.json`);
    const prompt = existsSync(promptPath) ? await readFile(promptPath, 'utf8') : '';
    const stdin = `${prompt.trim()}\n\n${contextText.trim()}\n`;
    const args = [
      'exec',
      '--cd',
      cwd,
      '--sandbox',
      'workspace-write',
      '--add-dir',
      localDir,
      '-c',
      'sandbox_workspace_write.network_access=true',
      '--output-last-message',
      resolvedReportPath,
      '-',
    ];
    const result = await exec(codexCommand, args, {
      cwd,
      stdin,
      timeout: 1800000,
      reportPath: resolvedReportPath,
    });
    if (result.code !== 0) return { ok: false, reason: `Codex ${phase} exited ${result.code}: ${summarizeOutput(result)}` };
    let reportText;
    try {
      reportText = await readFile(resolvedReportPath, 'utf8');
    } catch {
      return { ok: false, reason: `Codex ${phase} report missing` };
    }
    try {
      return { ok: true, report: JSON.parse(reportText) };
    } catch {
      return { ok: false, reason: `Codex ${phase} invalid JSON` };
    }
  }

  async function searchIssueByMarker(marker) {
    const result = await exec('gh', [
      'issue',
      'list',
      '--repo',
      REPO,
      '--state',
      'all',
      '--limit',
      '100',
      '--search',
      `${marker} in:body`,
      '--json',
      'number,title,state,url,labels',
    ], { cwd });
    if (result.code !== 0) throw new Error(`marker search failed: ${summarizeOutput(result)}`);
    const issues = parseJson(result.stdout);
    return Array.isArray(issues) && issues.length > 0 ? issues[0] : null;
  }

  async function discover({ preflight: runPreflight = true } = {}) {
    if (runPreflight) {
      const check = await preflight();
      if (!check.ok) return { status: 'failed', reason: check.reason };
    }
    const codex = await runCodexJson({
      phase: 'discover',
      promptPath: path.join(paths.prompts, 'discovery.md'),
      contextText: 'Find one local self-improvement candidate for codex-orchestrator.',
      reportPath: path.join(paths.reports, 'discovery.json'),
    });
    if (!codex.ok) return { status: 'failed', reason: codex.reason };
    const validation = validateDiscoveryReport(codex.report);
    if (!validation.ok) return { status: 'skipped', reason: validation.reason };
    const candidate = validation.candidates[0];
    const fingerprint = fingerprintCandidate(candidate);
    const existing = await searchIssueByMarker(`source-candidate-fingerprint:${fingerprint}`);
    if (existing) {
      const state = await loadState();
      await saveState({ ...state, lastDiscovery: { status: 'reused', issueNumber: existing.number, fingerprint, at: now().toISOString() } });
      return { status: 'reused', issueNumber: existing.number, url: existing.url, fingerprint };
    }
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'self-improvement-issue-'));
    const bodyPath = path.join(tmp, 'body.md');
    await writeFile(bodyPath, renderDiscoveryIssue(candidate, fingerprint, now().toISOString().slice(0, 10)));
    const created = await exec('gh', [
      'issue',
      'create',
      '--repo',
      REPO,
      '--title',
      `Self-improvement: ${candidate.title}`,
      '--body-file',
      bodyPath,
      '--label',
      'agent:auto',
      '--label',
      'self-improvement',
    ], { cwd });
    if (created.code !== 0) return { status: 'failed', reason: `issue create failed: ${summarizeOutput(created)}` };
    const issueNumber = issueNumberFromUrl(created.stdout);
    const state = await loadState();
    await saveState({ ...state, lastDiscovery: { status: 'created', issueNumber, fingerprint, at: now().toISOString() } });
    return { status: 'created', issueNumber, url: created.stdout.trim(), fingerprint };
  }

  async function implement({ issue } = {}) {
    if (!Number.isInteger(Number(issue))) return { status: 'skipped', reason: 'missing issue number' };
    const build = await exec('npm', ['run', 'build', '--silent'], { cwd });
    if (build.code !== 0) return { status: 'failed', exitCode: build.code, reason: `build failed: ${summarizeOutput(build)}` };
    const result = await exec('node', ['dist/src/cli.js', 'run', '--target', '.', '--issue', String(issue)], { cwd });
    if (result.code === 0) return { status: 'passed', exitCode: 0, summary: summarizeOutput(result), issueNumber: Number(issue) };
    return { status: 'failed', exitCode: result.code, reason: summarizeOutput(result), issueNumber: Number(issue) };
  }

  async function runLiveSmoke({ implementation } = {}) {
    if (!implementation || implementation.status !== 'passed' || implementation.exitCode !== 0) {
      return { status: 'skipped', reason: implementation?.reason ? `implementation failed: ${implementation.reason}` : 'implementation not started or not successful' };
    }
    const result = await exec('npm', ['run', 'smoke:live'], { cwd });
    const smoke = { status: result.code === 0 ? 'passed' : 'failed', exitCode: result.code, summary: summarizeOutput(result) };
    const state = await loadState();
    await saveState({ ...state, lastLiveSmoke: { ...smoke, at: now().toISOString() } });
    return smoke;
  }

  async function listReviewSources() {
    const result = await exec('gh', [
      'issue',
      'list',
      '--repo',
      REPO,
      '--state',
      'all',
      '--limit',
      '100',
      '--search',
      `self-improvement-runner-id:${RUNNER_ID} in:body`,
      '--json',
      'number,title,state,url,labels',
    ], { cwd });
    if (result.code !== 0) throw new Error(`review source list failed: ${summarizeOutput(result)}`);
    return parseJson(result.stdout).slice(0, 100);
  }

  async function viewIssue(number) {
    const result = await exec('gh', [
      'issue',
      'view',
      String(number),
      '--repo',
      REPO,
      '--json',
      'number,title,body,state,url,labels,comments,closedByPullRequestsReferences',
    ], { cwd });
    if (result.code !== 0) throw new Error(`issue view failed for ${number}: ${summarizeOutput(result)}`);
    return parseJson(result.stdout);
  }

  async function review({ preflight: runPreflight = true } = {}) {
    if (runPreflight) {
      const check = await preflight();
      if (!check.ok) return { status: 'failed', reason: check.reason, created: [], reused: [] };
    }
    const sourceSummaries = await listReviewSources();
    const eligible = [];
    for (const summary of sourceSummaries) {
      if (eligible.length >= 5) break;
      if (labelsOf(summary).includes('agent:running') || labelsOf(summary).includes('agent:blocked')) continue;
      const issue = await viewIssue(summary.number);
      if (isReviewEligible(issue)) eligible.push(issue);
    }
    const created = [];
    const reused = [];
    for (const issue of eligible) {
      const codex = await runCodexJson({
        phase: 'review',
        promptPath: path.join(paths.prompts, 'review.md'),
        contextText: JSON.stringify({ sourceIssue: issue }, null, 2),
        reportPath: path.join(paths.reports, `review-${issue.number}.json`),
      });
      if (!codex.ok) continue;
      const validation = validateReviewReport(codex.report);
      if (!validation.ok) continue;
      for (const finding of validation.findings.slice(0, 5)) {
        const fingerprint = fingerprintFinding(finding);
        const existing = await searchIssueByMarker(`finding-fingerprint:${fingerprint}`);
        if (existing) {
          reused.push({ issueNumber: existing.number, fingerprint });
          continue;
        }
        const tmp = await mkdtemp(path.join(os.tmpdir(), 'self-improvement-follow-up-'));
        const bodyPath = path.join(tmp, 'body.md');
        await writeFile(bodyPath, renderFollowUpIssue(finding, fingerprint));
        const result = await exec('gh', [
          'issue',
          'create',
          '--repo',
          REPO,
          '--title',
          `Self-improvement follow-up: ${finding.summary}`,
          '--body-file',
          bodyPath,
          '--label',
          'agent:manual',
          '--label',
          'self-improvement',
        ], { cwd });
        if (result.code === 0) created.push({ issueNumber: issueNumberFromUrl(result.stdout), fingerprint });
      }
    }
    const state = await loadState();
    await saveState({ ...state, lastReview: { created, reused, at: now().toISOString() } });
    return { status: 'completed', created, reused, reviewedSources: eligible.map((issue) => issue.number) };
  }

  async function daily() {
    const phases = [];
    let lockAcquired = false;
    const addPhase = (name, result) => {
      const phase = dailyPhase.result(name, result);
      phases.push(phase);
      return phase;
    };
    try {
      await acquireLock();
      lockAcquired = true;
      const check = await preflight();
      addPhase('preflight', { status: check.ok ? 'passed' : 'failed', reason: check.reason });
      if (!check.ok) return { exitCode: dailyPhase.exitCode(phases), phases };

      const discovery = await discover({ preflight: false });
      addPhase('discover', discovery);

      let implementation = { status: 'skipped', reason: 'discovery did not produce an issue number' };
      if (discovery.issueNumber) {
        implementation = await implement({ issue: discovery.issueNumber });
      }
      addPhase('implement', implementation);

      const smoke = await runLiveSmoke({ implementation });
      addPhase('live-smoke', smoke);

      const reviewResult = await review({ preflight: false });
      addPhase('review', reviewResult);
      return { exitCode: dailyPhase.exitCode(phases), phases };
    } catch (error) {
      addPhase('runner', { status: 'failed', reason: error.message });
      return { exitCode: dailyPhase.exitCode(phases), phases };
    } finally {
      if (lockAcquired) await releaseLock();
    }
  }

  function printSummary(result) {
    for (const line of dailyPhase.summaryLines(result.phases)) console.log(line);
  }

  return {
    paths,
    preflight,
    acquireLock,
    releaseLock,
    loadState,
    saveState,
    runCodexJson,
    searchIssueByMarker,
    discover,
    implement,
    runLiveSmoke,
    review,
    daily,
    printSummary,
  };
}

async function main() {
  const runner = createRunner();
  const [command, ...args] = process.argv.slice(2);
  if (!command || !['daily', 'discover', 'implement', 'review'].includes(command)) {
    console.error('Usage: node runner.mjs <daily|discover|implement --issue <number>|review>');
    process.exit(2);
  }
  if (command === 'daily') {
    const result = await runner.daily();
    runner.printSummary(result);
    process.exit(result.exitCode);
  }
  if (command === 'discover') {
    const result = await runner.discover();
    console.log(`discover: ${result.status}${result.issueNumber ? ` issue #${result.issueNumber}` : ''}${result.reason ? ` (${result.reason})` : ''}`);
    process.exit(result.status === 'failed' ? 1 : 0);
  }
  if (command === 'implement') {
    const issue = args[args.indexOf('--issue') + 1];
    const result = await runner.implement({ issue: Number(issue) });
    console.log(`implement: ${result.status}${result.issueNumber ? ` issue #${result.issueNumber}` : ''}${result.reason ? ` (${result.reason})` : ''}`);
    process.exit(result.status === 'failed' ? 1 : 0);
  }
  if (command === 'review') {
    const result = await runner.review();
    console.log(`review: ${result.status} created=${result.created.length} reused=${result.reused.length}${result.reason ? ` (${result.reason})` : ''}`);
    process.exit(result.status === 'failed' ? 1 : 0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
