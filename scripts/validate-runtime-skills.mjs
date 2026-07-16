import { resolve } from 'node:path';

import { loadPackageSkillBundle } from '../dist/src/skills/package-skill-bundle.js';

const loaded = await loadPackageSkillBundle(resolve('.'));
process.stdout.write(`${loaded.manifest.bundleHash}\n`);
