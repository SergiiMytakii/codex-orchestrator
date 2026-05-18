import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { readPackageInfo } from '../package-info.js';
import { workflowDefinitions } from './workflows.js';

export const promptSyncModes = ['auto', 'keep', 'replace', 'merge'] as const;
export type PromptSyncMode = (typeof promptSyncModes)[number];

export interface PromptSyncResult {
  manifestPath: string;
  installed: string[];
  updated: string[];
  preserved: string[];
  conflicts: string[];
}

export function promptConflictGuidance(commandPrefix = 'codex-orchestrator setup'): string[] {
  return [
    'Choose how to handle local prompt edits:',
    `- Keep local prompts: ${commandPrefix} --sync-prompts=keep`,
    `- Merge package updates into local prompts: ${commandPrefix} --sync-prompts=merge`,
    `- Replace local prompts: ${commandPrefix} --sync-prompts=replace`,
    'Ask the user which action to take before changing conflicted prompts.',
  ];
}

interface PromptManifest {
  version: 1;
  packageName: string;
  packageVersion: string;
  prompts: Record<string, PromptManifestEntry>;
}

interface PromptManifestEntry {
  installedHash: string;
  packageHash: string;
  packageVersion: string;
  conflict?: boolean;
}

interface PromptDefinition {
  sourceRelativePath: string;
  destinationRelativePath: string;
  manifestKey: string;
}

export function promptManifestPath(targetRoot: string): string {
  return join(targetRoot, '.codex-orchestrator', 'prompts', 'manifest.json');
}

export async function checkPromptFiles(targetRoot: string, mode: PromptSyncMode = 'auto'): Promise<PromptSyncResult> {
  return visitPromptFiles(targetRoot, mode, false);
}

export async function syncPromptFiles(targetRoot: string, mode: PromptSyncMode): Promise<PromptSyncResult> {
  return visitPromptFiles(targetRoot, mode, true);
}

async function visitPromptFiles(targetRoot: string, mode: PromptSyncMode, write: boolean): Promise<PromptSyncResult> {
  const packageInfo = await readPackageInfo();
  const manifestPath = promptManifestPath(targetRoot);
  const manifest = await readPromptManifest(manifestPath, packageInfo.name, packageInfo.version);
  const result: PromptSyncResult = {
    manifestPath,
    installed: [],
    updated: [],
    preserved: [],
    conflicts: [],
  };

  for (const definition of promptDefinitions()) {
    const destination = join(targetRoot, definition.destinationRelativePath);
    const source = new URL(`../../../prompts/${definition.sourceRelativePath}`, import.meta.url);
    const packageContent = await readFile(source, 'utf8');
    const packageHash = sha256(packageContent);
    const existingContent = await readOptionalFile(destination);
    const existingHash = existingContent === undefined ? undefined : sha256(existingContent);
    const entry = manifest.prompts[definition.manifestKey];

    if (mode === 'replace' || existingContent === undefined) {
      if (write) {
        await mkdir(dirname(destination), { recursive: true });
        await cp(source, destination, { force: true });
      }
      manifest.prompts[definition.manifestKey] = manifestEntry(packageHash, packageInfo.version);
      result[existingContent === undefined ? 'installed' : 'updated'].push(definition.manifestKey);
      continue;
    }

    if (existingHash === packageHash) {
      manifest.prompts[definition.manifestKey] = manifestEntry(packageHash, packageInfo.version);
      result.preserved.push(definition.manifestKey);
      continue;
    }

    if (!entry) {
      if (mode === 'merge') {
        manifest.prompts[definition.manifestKey] = await mergePromptUpdate({
          destination,
          existingContent,
          packageContent,
          packageHash,
          packageVersion: packageInfo.version,
          promptKey: definition.manifestKey,
          write,
        });
        result.updated.push(definition.manifestKey);
      } else if (mode === 'keep') {
        result.preserved.push(definition.manifestKey);
        manifest.prompts[definition.manifestKey] = manifestEntry(packageHash, packageInfo.version);
      } else {
        result.conflicts.push(definition.manifestKey);
        manifest.prompts[definition.manifestKey] = {
          ...manifestEntry(packageHash, packageInfo.version),
          conflict: true,
        };
      }
      continue;
    }

    if (entry.conflict) {
      if (mode === 'merge') {
        manifest.prompts[definition.manifestKey] = await mergePromptUpdate({
          destination,
          existingContent,
          packageContent,
          packageHash,
          packageVersion: packageInfo.version,
          promptKey: definition.manifestKey,
          write,
        });
        result.updated.push(definition.manifestKey);
      } else if (mode === 'keep') {
        result.preserved.push(definition.manifestKey);
      } else {
        result.conflicts.push(definition.manifestKey);
      }
      continue;
    }

    const installedHash = entry?.installedHash ?? packageHash;
    const previousPackageHash = entry?.packageHash ?? packageHash;
    const localModified = existingHash !== installedHash;
    const packageChanged = previousPackageHash !== packageHash;
    const canAutoUpdate = !localModified && (mode === 'auto' || mode === 'merge');

    if (canAutoUpdate) {
      if (write) {
        await writeFile(destination, packageContent, 'utf8');
      }
      manifest.prompts[definition.manifestKey] = manifestEntry(packageHash, packageInfo.version);
      result.updated.push(definition.manifestKey);
      continue;
    }

    if (localModified && packageChanged && mode === 'merge') {
      manifest.prompts[definition.manifestKey] = await mergePromptUpdate({
        destination,
        existingContent,
        packageContent,
        packageHash,
        packageVersion: packageInfo.version,
        promptKey: definition.manifestKey,
        write,
      });
      result.updated.push(definition.manifestKey);
      continue;
    }

    if (localModified && packageChanged && mode === 'auto') {
      result.conflicts.push(definition.manifestKey);
    } else {
      result.preserved.push(definition.manifestKey);
    }
    manifest.prompts[definition.manifestKey] = {
      installedHash,
      packageHash,
      packageVersion: packageInfo.version,
    };
  }

  if (write) {
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return result;
}

async function readPromptManifest(path: string, packageName: string, packageVersion: string): Promise<PromptManifest> {
  try {
    const content = await readFile(path, 'utf8');
    const parsed = JSON.parse(content) as Partial<PromptManifest>;
    if (parsed.version === 1 && typeof parsed.prompts === 'object' && parsed.prompts !== null) {
      return {
        version: 1,
        packageName,
        packageVersion,
        prompts: parsed.prompts,
      };
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  return { version: 1, packageName, packageVersion, prompts: {} };
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function promptDefinitions(): PromptDefinition[] {
  return [
    {
      sourceRelativePath: 'setup-skill.md',
      destinationRelativePath: '.codex-orchestrator/prompts/setup-skill.md',
      manifestKey: 'setup-skill.md',
    },
    ...workflowDefinitions.map((definition) => {
      const name = definition.promptPath.replace('.codex-orchestrator/prompts/', '');
      return {
        sourceRelativePath: name,
        destinationRelativePath: definition.promptPath,
        manifestKey: name,
      };
    }),
  ];
}

function manifestEntry(packageHash: string, packageVersion: string): PromptManifestEntry {
  return {
    installedHash: packageHash,
    packageHash,
    packageVersion,
  };
}

async function mergePromptUpdate(input: {
  destination: string;
  existingContent: string;
  packageContent: string;
  packageHash: string;
  packageVersion: string;
  promptKey: string;
  write: boolean;
}): Promise<PromptManifestEntry> {
  const mergedContent = appendPackagePromptUpdate(input.existingContent, input.promptKey, input.packageVersion, input.packageContent);
  if (input.write) {
    await writeFile(input.destination, mergedContent, 'utf8');
  }

  return {
    installedHash: sha256(mergedContent),
    packageHash: input.packageHash,
    packageVersion: input.packageVersion,
  };
}

function appendPackagePromptUpdate(existingContent: string, promptKey: string, packageVersion: string, packageContent: string): string {
  return [
    existingContent.trimEnd(),
    '',
    `<!-- codex-orchestrator package prompt update: ${promptKey} @ ${packageVersion} -->`,
    packageContent.trimEnd(),
    `<!-- end codex-orchestrator package prompt update: ${promptKey} @ ${packageVersion} -->`,
    '',
  ].join('\n');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
