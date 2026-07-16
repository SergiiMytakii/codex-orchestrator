#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const volatileFrontmatterKeys = new Set([
  'status',
  'review_outcome',
  'review_verdict',
  'reviewed_revision',
  'review_coverage',
]);

export function canonicalize(text) {
  let lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n').map((line) => line.trimEnd());
  if (lines[0] === '---') {
    const closing = lines.indexOf('---', 1);
    if (closing >= 0) {
      lines = [
        '---',
        ...lines.slice(1, closing).filter((line) => {
          const separator = line.indexOf(':');
          return separator < 0 || !volatileFrontmatterKeys.has(line.slice(0, separator).trim());
        }),
        ...lines.slice(closing),
      ];
    }
  }
  const defectStart = lines.indexOf('## Defect Closure Notes');
  if (defectStart >= 0) {
    const nextHeadingOffset = lines.slice(defectStart + 1).findIndex((line) => line.startsWith('## '));
    lines = nextHeadingOffset < 0
      ? lines.slice(0, defectStart)
      : [...lines.slice(0, defectStart), ...lines.slice(defectStart + 1 + nextHeadingOffset)];
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function fingerprint(text) {
  return createHash('sha256').update(canonicalize(text), 'utf8').digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    process.stderr.write('Usage: artifact-review-fingerprint.mjs <artifact>\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(`${fingerprint(await readFile(process.argv[2], 'utf8'))}\n`);
  }
}
