import { join, resolve } from 'node:path';

import {
  parseAndroidVisualProofArgs,
  runAndroidVisualProofCommand,
  type AndroidVisualProofCommandInput,
} from './android-visual-proof-command.js';
import { runIosVisualProofCommand, type IosVisualProofCommandInput } from './ios-visual-proof-command.js';

type MobileProofProjectType = 'auto' | 'flutter' | 'android' | 'ios';

export interface MobileVisualProofCommandInput extends Omit<AndroidVisualProofCommandInput, 'projectType'> {
  projectType?: MobileProofProjectType;
  iosBundleId?: string;
  iosScheme?: string;
}

export async function runMobileVisualProofCommand(input: MobileVisualProofCommandInput): Promise<void> {
  const worktreePath = resolve(input.worktreePath ?? input.env?.CODEX_ORCHESTRATOR_WORKTREE_PATH ?? process.cwd());
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const project = input.projectType && input.projectType !== 'auto'
    ? projectFromConfiguredType(input.projectType, await detectMobileProject(worktreePath))
    : await detectMobileProject(worktreePath);

  if (project === 'ios' || project === 'flutter-ios') {
    await runIosVisualProofCommand(toIosInput(input, worktreePath));
    return;
  }

  try {
    await runAndroidVisualProofCommand({ ...input, worktreePath, projectType: androidProjectType(project) });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!shouldFallbackToIos(message) || !hasIosTarget(project) || platform !== 'darwin') {
      throw error;
    }
    await runIosVisualProofCommand({
      ...toIosInput(input, worktreePath),
      fallbackReason: message.split('\n')[0],
      env,
      platform,
    });
  }
}

export function parseMobileVisualProofArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: MobileVisualProofCommandInput } | { ok: false; error: string } {
  const androidArgs: string[] = [];
  const mobileOnly: Pick<MobileVisualProofCommandInput, 'iosBundleId' | 'iosScheme' | 'projectType'> = {
    iosBundleId: env.CODEX_ORCHESTRATOR_IOS_BUNDLE_ID,
    iosScheme: env.CODEX_ORCHESTRATOR_IOS_SCHEME,
    projectType: mobileProjectTypeFromEnv(env.CODEX_ORCHESTRATOR_MOBILE_PROJECT_TYPE),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = (): string | undefined => {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) return undefined;
      index += 1;
      return value;
    };

    switch (arg) {
      case '--project': {
        const value = next();
        if (value !== 'auto' && value !== 'flutter' && value !== 'android' && value !== 'ios') {
          return { ok: false, error: '--project must be auto, flutter, android, or ios' };
        }
        mobileOnly.projectType = value;
        if (value !== 'ios') androidArgs.push(arg, value);
        break;
      }
      case '--bundle-id': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        mobileOnly.iosBundleId = value;
        break;
      }
      case '--scheme': {
        const value = next();
        if (!value) return { ok: false, error: `${arg} requires a value` };
        mobileOnly.iosScheme = value;
        break;
      }
      default:
        androidArgs.push(arg);
        if (arg.startsWith('--')) {
          const value = args[index + 1];
          if (value && !value.startsWith('--')) {
            androidArgs.push(value);
            index += 1;
          }
        }
        break;
    }
  }

  const parsed = parseAndroidVisualProofArgs(androidArgs, env);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error.replace('visual-proof android', 'visual-proof mobile') };
  }
  return {
    ok: true,
    value: {
      ...parsed.value,
      projectType: mobileOnly.projectType ?? parsed.value.projectType,
      iosBundleId: mobileOnly.iosBundleId,
      iosScheme: mobileOnly.iosScheme,
    },
  };
}

async function detectMobileProject(worktreePath: string): Promise<'flutter-ios' | 'flutter-android' | 'flutter-both' | 'android' | 'ios'> {
  const { stat } = await import('node:fs/promises');
  const exists = async (path: string): Promise<boolean> => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  };
  const flutter = await exists(join(worktreePath, 'pubspec.yaml'));
  const android = await exists(join(worktreePath, 'android')) || await exists(join(worktreePath, 'gradlew')) || await exists(join(worktreePath, 'gradlew.bat'));
  const ios = await exists(join(worktreePath, 'ios')) || await hasTopLevelXcodeProject(worktreePath);
  if (flutter && android && ios) return 'flutter-both';
  if (flutter && ios) return 'flutter-ios';
  if (flutter && android) return 'flutter-android';
  if (ios) return 'ios';
  return 'android';
}

async function hasTopLevelXcodeProject(worktreePath: string): Promise<boolean> {
  const { readdir } = await import('node:fs/promises');
  try {
    const entries = await readdir(worktreePath, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory() && (entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace')));
  } catch {
    return false;
  }
}

function toIosInput(input: MobileVisualProofCommandInput, worktreePath: string): IosVisualProofCommandInput {
  return {
    issueNumber: input.issueNumber,
    worktreePath,
    artifactDir: input.artifactDir,
    env: input.env,
    platform: input.platform,
    projectType: input.projectType === 'flutter' || input.projectType === 'ios' ? input.projectType : undefined,
    flutterTarget: input.flutterTarget,
    flutterFlavor: input.flutterFlavor,
    iosBundleId: input.iosBundleId,
    iosScheme: input.iosScheme,
    launchSettleMs: input.launchSettleMs,
  };
}

function shouldFallbackToIos(message: string): boolean {
  return /Android platform tools were not found|No Android device is connected|emulator was not found|emulator -list-avds returned no AVDs/iu.test(message);
}

function hasIosTarget(project: Awaited<ReturnType<typeof detectMobileProject>>): boolean {
  return project === 'ios' || project === 'flutter-ios' || project === 'flutter-both';
}

function projectFromConfiguredType(
  configured: Exclude<MobileProofProjectType, 'auto'>,
  detected: Awaited<ReturnType<typeof detectMobileProject>>,
): Awaited<ReturnType<typeof detectMobileProject>> {
  if (configured === 'flutter') {
    return detected === 'flutter-ios' ? 'flutter-ios' : detected === 'flutter-both' ? 'flutter-both' : 'flutter-android';
  }
  return configured;
}

function androidProjectType(
  project: Awaited<ReturnType<typeof detectMobileProject>>,
): AndroidVisualProofCommandInput['projectType'] {
  return project === 'android' ? 'android' : 'flutter';
}

function mobileProjectTypeFromEnv(value: string | undefined): MobileProofProjectType | undefined {
  if (value === 'auto' || value === 'flutter' || value === 'android' || value === 'ios') return value;
  return undefined;
}
