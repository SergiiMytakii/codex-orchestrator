import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyBridgeRuntimeManifest,
  writeBridgeRuntimeManifest,
} from '../dist/src/bridge-runtime.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = await writeBridgeRuntimeManifest(root);
await verifyBridgeRuntimeManifest(root);
process.stdout.write(`${manifest.packageHash}\n`);
