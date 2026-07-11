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
const ISSUE_LIST_LIMIT = 100;
const ISSUE_LIST_JSON_FIELDS = 'number,title,state,url,labels';
const RUNNER_ID_MARKER = `self-improvement-runner-id:${RUNNER_ID}`;

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

function normalizeResidualRisks(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(nonEmptyString).map((risk) => risk.trim());
}

function hasRequiredFields(item, fieldValidators) {
  return Object.entries(fieldValidators).every(([field, validator]) => validator(item[field]));
}

function createReportContract({
  itemKey,
  shapeReason,
  noValidReason,
  allowEmptyValidItems = false,
  itemLimit,
  isValidItem,
}) {
  return Object.freeze({
    validate(report) {
      if (!report || report.status !== 'completed' || !Array.isArray(report[itemKey])) {
        return { ok: false, reason: shapeReason };
      }
      const items = report[itemKey];
      const valid = items.filter(isValidItem);
      if (valid.length === 0 && (!allowEmptyValidItems || items.length > 0)) {
        return { ok: false, reason: noValidReason };
      }
      const limited = Number.isInteger(itemLimit) ? valid.slice(0, itemLimit) : valid;
      return { ok: true, [itemKey]: limited, residualRisks: normalizeResidualRisks(report.residualRisks) };
    },
  });
}

const discoveryCandidateFields = Object.freeze({
  title: nonEmptyString,
  files: nonEmptyStringArray,
  problem: nonEmptyString,
  solution: nonEmptyString,
  benefits: nonEmptyStringArray,
  verification: nonEmptyStringArray,
  risk: nonEmptyString,
  adrConflict: nonEmptyString,
});

const reviewFindingFields = Object.freeze({
  summary: nonEmptyString,
  evidence: nonEmptyString,
  proposedFix: nonEmptyString,
  sourceIssue: (value) => Number.isInteger(Number(value)),
  findingFingerprint: nonEmptyString,
});

function isValidDiscoveryCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (!hasRequiredFields(candidate, discoveryCandidateFields)) return false;
  return candidate.adrConflict.trim().toLowerCase() === 'none';
}

function isValidReviewFinding(finding) {
  if (!finding || typeof finding !== 'object') return false;
  return hasRequiredFields(finding, reviewFindingFields);
}

export const reportContracts = Object.freeze({
  discovery: createReportContract({
    itemKey: 'candidates',
    shapeReason: 'Discovery report must contain status completed and candidates array.',
    noValidReason: 'Discovery report has no valid candidates.',
    isValidItem: isValidDiscoveryCandidate,
  }),
  review: createReportContract({
    itemKey: 'findings',
    shapeReason: 'Review report must contain status completed and findings array.',
    noValidReason: 'Review report has findings but none are valid.',
    allowEmptyValidItems: true,
    itemLimit: 5,
    isValidItem: isValidReviewFinding,
  }),
});

export function validateDiscoveryReport(report) {
  return reportContracts.discovery.validate(report);
}

export function validateReviewReport(report) {
  return reportContracts.review.validate(report);
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

function markerValue(marker) {
  const index = String(marker).indexOf(':');
  return index === -1 ? String(marker) : String(marker).slice(index + 1);
}

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean);
}

export function classifyIssueWorkflow(issue) {
  const labels = labelsOf(issue);
  const isSelfImprovement = labels.includes('self-improvement');
  const hasBlockingWorkflowState = labels.includes('agent:running') || labels.includes('agent:blocked');
  const closedByPullRequestsReferences = Array.isArray(issue.closedByPullRequestsReferences)
    ? issue.closedByPullRequestsReferences
    : [];
  return {
    labels,
    isSelfImprovement,
    isCodeIssue: isSelfImprovement && labels.includes('agent:auto'),
    hasBlockingWorkflowState,
    isBlockedWorkflowState: labels.includes('agent:blocked'),
    isReviewEligible: isSelfImprovement
      && !hasBlockingWorkflowState
      && (labels.includes('agent:review') || closedByPullRequestsReferences.length > 0),
  };
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
  return phase?.status === 'failed' || phase?.status === 'blocked';
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

  async function listIssuesByBodySearch({ state = 'open', search, errorPrefix = 'issue list' } = {}) {
    const result = await exec('gh', [
      'issue',
      'list',
      '--repo',
      REPO,
      '--state',
      state,
      '--limit',
      String(ISSUE_LIST_LIMIT),
      '--search',
      search,
      '--json',
      ISSUE_LIST_JSON_FIELDS,
    ], { cwd });
    if (result.code !== 0) throw new Error(`${errorPrefix} failed: ${summarizeOutput(result)}`);
    const issues = parseJson(result.stdout);
    return Array.isArray(issues) ? issues.slice(0, ISSUE_LIST_LIMIT) : [];
  }

  function selfImprovementBodySearch(bodyTerms = []) {
    return [RUNNER_ID_MARKER, ...bodyTerms].filter(Boolean).join(' ').trim() + ' in:body';
  }

  async function searchIssueByMarker(marker) {
    const issues = await listIssuesByBodySearch({
      state: 'all',
      search: `${marker} in:body`,
      errorPrefix: 'marker search',
    });
    return issues.length > 0 ? issues[0] : null;
  }

  async function listSelfImprovementIssues({ state = 'open', bodyTerms = [] } = {}) {
    return listIssuesByBodySearch({
      state,
      search: selfImprovementBodySearch(bodyTerms),
      errorPrefix: 'self-improvement issue list',
    });
  }

  async function selectDailyIssue() {
    const activeIssues = await listSelfImprovementIssues({
      state: 'open',
    });
    const active = activeIssues.find((issue) => classifyIssueWorkflow(issue).isCodeIssue);
    if (active) {
      return { status: 'existing', issueNumber: active.number, issue: active, classification: classifyIssueWorkflow(active) };
    }

    const date = now().toISOString().slice(0, 10);
    const todaysIssues = await listSelfImprovementIssues({
      state: 'all',
      bodyTerms: [`source-date:${date}`],
    });
    const todays = todaysIssues.find((issue) => classifyIssueWorkflow(issue).isCodeIssue);
    if (todays) {
      return {
        status: 'daily-limit',
        issueNumber: todays.number,
        issue: todays,
        classification: classifyIssueWorkflow(todays),
        reason: `self-improvement issue already created today: #${todays.number}`,
      };
    }

    return { status: 'none' };
  }

  async function publishSelfImprovementIssue({
    marker,
    title,
    body,
    agentLabel,
  }) {
    const existing = await searchIssueByMarker(marker);
    const fingerprint = markerValue(marker);
    if (existing) {
      return { status: 'reused', issueNumber: existing.number, url: existing.url, fingerprint };
    }

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'self-improvement-issue-'));
    const bodyPath = path.join(tmp, 'body.md');
    await writeFile(bodyPath, body);
    const created = await exec('gh', [
      'issue',
      'create',
      '--repo',
      REPO,
      '--title',
      title,
      '--body-file',
      bodyPath,
      '--label',
      agentLabel,
      '--label',
      'self-improvement',
    ], { cwd });
    if (created.code !== 0) return { status: 'failed', reason: `issue create failed: ${summarizeOutput(created)}`, fingerprint };
    const url = created.stdout.trim();
    return { status: 'created', issueNumber: issueNumberFromUrl(url), url, fingerprint };
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
    const publication = await publishSelfImprovementIssue({
      marker: `source-candidate-fingerprint:${fingerprint}`,
      title: `Self-improvement: ${candidate.title}`,
      body: renderDiscoveryIssue(candidate, fingerprint, now().toISOString().slice(0, 10)),
      agentLabel: 'agent:auto',
    });
    if (publication.status === 'failed') return { status: 'failed', reason: publication.reason };
    const state = await loadState();
    await saveState({
      ...state,
      lastDiscovery: {
        status: publication.status,
        issueNumber: publication.issueNumber,
        fingerprint,
        at: now().toISOString(),
      },
    });
    return publication;
  }

  async function implement({ issue } = {}) {
    if (!Number.isInteger(Number(issue))) return { status: 'skipped', reason: 'missing issue number' };
    const build = await exec('npm', ['run', 'build', '--silent'], { cwd });
    if (build.code !== 0) return { status: 'failed', exitCode: build.code, reason: `build failed: ${summarizeOutput(build)}` };
    const result = await exec('node', ['dist/src/cli.js', 'run', '--target', '.', '--issue', String(issue)], { cwd });
    const summary = summarizeOutput(result);
    if (result.code === 0 && /blocked scoped execution|outcome:\s*blocked|status:\s*blocked/iu.test(summary)) {
      return { status: 'blocked', exitCode: 0, reason: summary, issueNumber: Number(issue) };
    }
    if (result.code === 0) return { status: 'passed', exitCode: 0, summary, issueNumber: Number(issue) };
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
    return listSelfImprovementIssues({
      state: 'all',
    });
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

  async function selectReviewSources({ limit = 5 } = {}) {
    const sourceSummaries = await listReviewSources();
    const eligible = [];
    for (const summary of sourceSummaries) {
      if (eligible.length >= limit) break;
      if (classifyIssueWorkflow(summary).hasBlockingWorkflowState) continue;
      const issue = await viewIssue(summary.number);
      if (classifyIssueWorkflow(issue).isReviewEligible) eligible.push(issue);
    }
    return eligible;
  }

  async function review({ preflight: runPreflight = true } = {}) {
    if (runPreflight) {
      const check = await preflight();
      if (!check.ok) return { status: 'failed', reason: check.reason, created: [], reused: [] };
    }
    const eligible = await selectReviewSources();
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
        const publication = await publishSelfImprovementIssue({
          marker: `finding-fingerprint:${fingerprint}`,
          title: `Self-improvement follow-up: ${finding.summary}`,
          body: renderFollowUpIssue(finding, fingerprint),
          agentLabel: 'agent:manual',
        });
        if (publication.status === 'created') created.push(publication);
        if (publication.status === 'reused') reused.push(publication);
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

      const selection = await selectDailyIssue();
      if (selection.status !== 'none') addPhase('select', selection);

      let issueNumber = selection.issueNumber;
      if (selection.status === 'none') {
        const discovery = await discover({ preflight: false });
        addPhase('discover', discovery);
        issueNumber = discovery.issueNumber;
      }

      let implementation = { status: 'skipped', reason: 'discovery did not produce an issue number' };
      const selectionClassification = selection.classification ?? (selection.issue ? classifyIssueWorkflow(selection.issue) : null);
      if (selection.status === 'daily-limit' && selection.issue?.state !== 'OPEN') {
        implementation = { status: 'skipped', reason: selection.reason, issueNumber };
      } else if (selectionClassification?.isBlockedWorkflowState) {
        implementation = { status: 'blocked', reason: `existing issue has blocking workflow state: ${selectionClassification.labels.join(', ')}`, issueNumber };
      } else if (selectionClassification?.hasBlockingWorkflowState) {
        implementation = { status: 'skipped', reason: `existing issue has blocking workflow state: ${selectionClassification.labels.join(', ')}`, issueNumber };
      } else if (issueNumber) {
        implementation = await implement({ issue: issueNumber });
      }
      addPhase('implement', implementation);

      const smoke = await runLiveSmoke({ implementation });
      addPhase('live-smoke', smoke);

      addPhase('review-backlog', { status: 'skipped', reason: 'daily run only creates or implements one self-improvement code issue' });
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
    listSelfImprovementIssues,
    selectDailyIssue,
    publishSelfImprovementIssue,
    discover,
    implement,
    runLiveSmoke,
    selectReviewSources,
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
