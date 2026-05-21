import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  androidSdkDefaultRoots,
  runAndroidVisualProofCommand,
} from '../src/runner/android-visual-proof-command.js';
import { runIosVisualProofCommand } from '../src/runner/ios-visual-proof-command.js';
import { parseMobileVisualProofArgs, runMobileVisualProofCommand } from '../src/runner/mobile-visual-proof-command.js';
import { buildProjectConfig } from '../src/setup/project-config.js';
import { fallbackWorkflows } from './fixtures/config.js';

test('android visual proof knows default Android SDK roots for macOS, Linux, and Windows', () => {
  assert.deepEqual(androidSdkDefaultRoots({ HOME: '/Users/alex' }, 'darwin'), [
    '/Users/alex/Library/Android/sdk',
  ]);
  assert.deepEqual(androidSdkDefaultRoots({ HOME: '/home/alex' }, 'linux'), [
    '/home/alex/Android/Sdk',
  ]);
  assert.deepEqual(
    androidSdkDefaultRoots({ LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local', USERPROFILE: 'C:\\Users\\alex' }, 'win32'),
    [
      'C:\\Users\\alex\\AppData\\Local\\Android\\Sdk',
      'C:\\Users\\alex\\AppData\\Local\\Android\\Sdk',
    ],
  );
});

test('package-owned Android visual proof captures Flutter launch screenshot using SDK defaults outside PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-android-proof-'));
  const home = join(root, 'home');
  const worktree = join(root, 'worktree');
  const sdk = join(home, 'Library', 'Android', 'sdk');
  const adbPath = join(sdk, 'platform-tools', 'adb');
  const emulatorPath = join(sdk, 'emulator', 'emulator');
  const flutterPath = join(root, 'flutter-bin', 'flutter');

  await mkdir(join(sdk, 'platform-tools'), { recursive: true });
  await mkdir(join(sdk, 'emulator'), { recursive: true });
  await mkdir(join(root, 'flutter-bin'), { recursive: true });
  await mkdir(join(worktree, 'android', 'app'), { recursive: true });
  await writeFile(join(worktree, 'pubspec.yaml'), 'name: app\n', 'utf8');
  await writeFile(
    join(worktree, 'android', 'app', 'build.gradle'),
    'android { defaultConfig { applicationId = "com.example.app" } }\n',
    'utf8',
  );
  await writeExecutable(adbPath, fakeAdbScript());
  await writeExecutable(emulatorPath, '#!/usr/bin/env bash\nprintf "Pixel_7\\n"\n');
  await writeExecutable(flutterPath, fakeFlutterScript());

  await runAndroidVisualProofCommand({
    issueNumber: 77,
    worktreePath: worktree,
    artifactDir: '.proofs',
    env: {
      HOME: home,
      CODEX_ORCHESTRATOR_FLUTTER_BIN: flutterPath,
      PATH: process.env.PATH ?? '',
    },
    platform: 'darwin',
    launchSettleMs: 0,
  });

  const screenshot = await readFile(join(worktree, '.proofs', 'issue-77', 'android-launch.png'), 'utf8');
  const summary = await readFile(join(worktree, '.proofs', 'issue-77', 'android-ui-summary.txt'), 'utf8');
  assert.equal(screenshot, 'fake-png');
  assert.match(summary, /Android visual proof/);
  assert.match(summary, /serial: ZX1G22/);
  assert.match(summary, /package: com\.example\.app/);
});

test('Android visual proof serializes device selection through a shared mobile device lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-android-lease-'));
  const home = join(root, 'home');
  const sdk = join(home, 'Library', 'Android', 'sdk');
  const adbPath = join(sdk, 'platform-tools', 'adb');
  const emulatorPath = join(sdk, 'emulator', 'emulator');
  const flutterPath = join(root, 'flutter-bin', 'flutter');
  const logPath = join(root, 'adb.log');
  const lockDir = join(root, 'mobile-device-locks');
  const worktree1 = join(root, 'worktree-1');
  const worktree2 = join(root, 'worktree-2');

  await mkdir(join(sdk, 'platform-tools'), { recursive: true });
  await mkdir(join(sdk, 'emulator'), { recursive: true });
  await mkdir(join(root, 'flutter-bin'), { recursive: true });
  await createFlutterAndroidFixture(worktree1);
  await createFlutterAndroidFixture(worktree2);
  await writeExecutable(adbPath, fakeAdbScript({ log: true }));
  await writeExecutable(emulatorPath, '#!/usr/bin/env bash\nprintf "Pixel_7\\n"\n');
  await writeExecutable(flutterPath, fakeFlutterScript());

  await Promise.all([
    runAndroidVisualProofCommand({
      issueNumber: 81,
      worktreePath: worktree1,
      artifactDir: '.proofs',
      env: proofEnv({ home, flutterPath, logPath, lockDir, issueNumber: 81 }),
      platform: 'darwin',
      launchSettleMs: 0,
    }),
    runAndroidVisualProofCommand({
      issueNumber: 82,
      worktreePath: worktree2,
      artifactDir: '.proofs',
      env: proofEnv({ home, flutterPath, logPath, lockDir, issueNumber: 82 }),
      platform: 'darwin',
      launchSettleMs: 0,
    }),
  ]);

  const events = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/u);
  const firstDeviceIndex = events.findIndex((event) => event.startsWith('devices-'));
  const firstIssue = events[firstDeviceIndex]?.split('-')[1];
  assert.ok(firstIssue);
  const firstScreencapIndex = events.findIndex((event) => event === `screencap-${firstIssue}`);
  const secondDeviceIndex = events.findIndex((event, index) => index > firstDeviceIndex && event.startsWith('devices-'));

  assert.ok(firstScreencapIndex > firstDeviceIndex);
  assert.ok(secondDeviceIndex > firstScreencapIndex);
});

test('mobile visual proof falls back to iOS simulator when Android tooling is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-mobile-proof-'));
  const worktree = join(root, 'worktree');
  const fakeBin = join(root, 'bin');
  const xcrunPath = join(fakeBin, 'xcrun');
  const flutterPath = join(fakeBin, 'flutter');

  await mkdir(join(worktree, 'ios', 'Runner.xcodeproj'), { recursive: true });
  await mkdir(join(worktree, 'android'), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(worktree, 'pubspec.yaml'), 'name: app\n', 'utf8');
  await writeFile(join(worktree, 'ios', 'Runner.xcodeproj', 'project.pbxproj'), 'PRODUCT_BUNDLE_IDENTIFIER = com.example.iosapp;\n', 'utf8');
  await writeExecutable(xcrunPath, fakeXcrunScript());
  await writeExecutable(flutterPath, fakeFlutterIosScript());

  await runMobileVisualProofCommand({
    issueNumber: 78,
    worktreePath: worktree,
    artifactDir: '.proofs',
    env: {
      HOME: join(root, 'home'),
      CODEX_ORCHESTRATOR_FLUTTER_BIN: flutterPath,
      PATH: `${fakeBin}:/bin`,
    },
    platform: 'darwin',
    launchSettleMs: 0,
  });

  const screenshot = await readFile(join(worktree, '.proofs', 'issue-78', 'ios-launch.png'), 'utf8');
  const summary = await readFile(join(worktree, '.proofs', 'issue-78', 'ios-ui-summary.txt'), 'utf8');
  assert.equal(screenshot, 'fake-ios-png');
  assert.match(summary, /iOS visual proof/);
  assert.match(summary, /fallbackFrom: Android platform tools were not found/);
  assert.match(summary, /bundleId: com\.example\.iosapp/);
});

test('package-owned iOS visual proof launches native iOS app in simulator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-ios-proof-'));
  const worktree = join(root, 'worktree');
  const fakeBin = join(root, 'bin');
  const xcrunPath = join(fakeBin, 'xcrun');
  const xcodebuildPath = join(fakeBin, 'xcodebuild');

  await mkdir(join(worktree, 'NativeApp.xcodeproj'), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(worktree, 'NativeApp.xcodeproj', 'project.pbxproj'), 'PRODUCT_BUNDLE_IDENTIFIER = com.example.native;\n', 'utf8');
  await writeExecutable(xcrunPath, fakeXcrunScript());
  await writeExecutable(xcodebuildPath, fakeXcodebuildScript());

  await runIosVisualProofCommand({
    issueNumber: 79,
    worktreePath: worktree,
    artifactDir: '.proofs',
    env: {
      PATH: `${fakeBin}:/bin`,
      HOME: join(root, 'home'),
    },
    platform: 'darwin',
    launchSettleMs: 0,
  });

  const screenshot = await readFile(join(worktree, '.proofs', 'issue-79', 'ios-launch.png'), 'utf8');
  const summary = await readFile(join(worktree, '.proofs', 'issue-79', 'ios-ui-summary.txt'), 'utf8');
  assert.equal(screenshot, 'fake-ios-png');
  assert.match(summary, /projectType: ios/);
  assert.match(summary, /bundleId: com\.example\.native/);
});

test('mobile visual proof parser accepts native iOS command flags', () => {
  const parsed = parseMobileVisualProofArgs([
    '--issue',
    '80',
    '--target',
    '/tmp/native-ios',
    '--project',
    'ios',
    '--bundle-id',
    'com.example.native',
    '--scheme',
    'NativeApp',
  ], {});

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.issueNumber, 80);
  assert.equal(parsed.value.worktreePath, '/tmp/native-ios');
  assert.equal(parsed.value.projectType, 'ios');
  assert.equal(parsed.value.iosBundleId, 'com.example.native');
  assert.equal(parsed.value.iosScheme, 'NativeApp');
});

test('setup default uses the package-owned mobile visual proof command', () => {
  const config = buildProjectConfig({
    owner: 'example',
    repo: 'mobile-app',
    prepareLabels: 'report-only',
    workflows: fallbackWorkflows,
  });

  assert.equal(
    config.reviewGates.visualProof.runnerValidationCommand,
    'codex-orchestrator visual-proof mobile --issue ${issueNumber}',
  );
});

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o755 });
}

async function createFlutterAndroidFixture(worktree: string): Promise<void> {
  await mkdir(join(worktree, 'android', 'app'), { recursive: true });
  await writeFile(join(worktree, 'pubspec.yaml'), 'name: app\n', 'utf8');
  await writeFile(
    join(worktree, 'android', 'app', 'build.gradle'),
    'android { defaultConfig { applicationId = "com.example.app" } }\n',
    'utf8',
  );
}

function proofEnv(input: {
  home: string;
  flutterPath: string;
  logPath: string;
  lockDir: string;
  issueNumber: number;
}): NodeJS.ProcessEnv {
  return {
    HOME: input.home,
    CODEX_ORCHESTRATOR_FLUTTER_BIN: input.flutterPath,
    CODEX_ORCHESTRATOR_MOBILE_DEVICE_LOCK_DIR: input.lockDir,
    CODEX_ORCHESTRATOR_ISSUE_NUMBER: String(input.issueNumber),
    CODEX_TEST_LOG: input.logPath,
    PATH: process.env.PATH ?? '',
  };
}

function fakeAdbScript(options: { log?: boolean } = {}): string {
  const logFunction = options.log
    ? `log_event() { printf "%s\\n" "$1-$CODEX_ORCHESTRATOR_ISSUE_NUMBER" >> "$CODEX_TEST_LOG"; }\n`
    : 'log_event() { :; }\n';
  return `#!/bin/bash
set -euo pipefail
${logFunction}
if [[ "$*" == "devices -l" ]]; then
  log_event devices
  printf "List of devices attached\\nZX1G22 device product:pixel model:Pixel_7 device:panther transport_id:1\\n"
  exit 0
fi
if [[ "$*" == "-s ZX1G22 wait-for-device" ]]; then
  exit 0
fi
if [[ "$*" == "-s ZX1G22 shell getprop sys.boot_completed" ]]; then
  printf "1\\n"
  exit 0
fi
if [[ "$*" == "-s ZX1G22 install -r -t build/app/outputs/flutter-apk/app-debug.apk" ]]; then
  printf "Success\\n"
  exit 0
fi
if [[ "$*" == "-s ZX1G22 shell cmd package resolve-activity --brief com.example.app" ]]; then
  printf "com.example.app/.MainActivity\\n"
  exit 0
fi
if [[ "$*" == "-s ZX1G22 shell am start -n com.example.app/.MainActivity" ]]; then
  exit 0
fi
if [[ "$*" == "-s ZX1G22 exec-out screencap -p" ]]; then
  log_event screencap
  sleep 0.1
  printf "fake-png"
  exit 0
fi
if [[ "$*" == "-s ZX1G22 exec-out uiautomator dump /dev/tty" ]]; then
  printf "<hierarchy><node text=\\"Home\\"/></hierarchy>"
  exit 0
fi
if [[ "$*" == "-s ZX1G22 logcat -d -t 300" ]]; then
  printf "logcat ok\\n"
  exit 0
fi
printf "unexpected adb args: %s\\n" "$*" >&2
exit 42
`;
}

function fakeFlutterScript(): string {
  return `#!/bin/bash
set -euo pipefail
if [[ "$1" == "build" && "$2" == "apk" ]]; then
  mkdir -p build/app/outputs/flutter-apk
  printf "apk" > build/app/outputs/flutter-apk/app-debug.apk
  exit 0
fi
printf "unexpected flutter args: %s\\n" "$*" >&2
exit 43
`;
}

function fakeFlutterIosScript(): string {
  return `#!/bin/bash
set -euo pipefail
if [[ "$1" == "build" && "$2" == "ios" ]]; then
  mkdir -p build/ios/iphonesimulator/Runner.app
  exit 0
fi
printf "unexpected flutter args: %s\\n" "$*" >&2
exit 44
`;
}

function fakeXcrunScript(): string {
  return `#!/bin/bash
set -euo pipefail
if [[ "$*" == "simctl list devices booted -j" ]]; then
  printf '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"name":"iPhone 16","udid":"SIM-1","state":"Booted","isAvailable":true}]}}'
  exit 0
fi
if [[ "$*" == "simctl install SIM-1 "* ]]; then
  exit 0
fi
if [[ "$*" == "simctl launch SIM-1 com.example.iosapp" ]]; then
  exit 0
fi
if [[ "$*" == "simctl launch SIM-1 com.example.native" ]]; then
  exit 0
fi
if [[ "$*" == "simctl io SIM-1 screenshot "* ]]; then
  printf "fake-ios-png" > "$5"
  exit 0
fi
printf "unexpected xcrun args: %s\\n" "$*" >&2
exit 45
`;
}

function fakeXcodebuildScript(): string {
  return `#!/bin/bash
set -euo pipefail
derived=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-derivedDataPath" ]]; then
    derived="$2"
    shift 2
    continue
  fi
  shift
done
if [[ -z "$derived" ]]; then
  printf "missing derived data path\\n" >&2
  exit 46
fi
mkdir -p "$derived/Build/Products/Debug-iphonesimulator/NativeApp.app"
exit 0
`;
}
