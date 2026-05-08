import { readFile } from 'node:fs/promises';

export interface PackageInfo {
  name: string;
  version: string;
}

interface PackageJsonShape {
  name?: unknown;
  version?: unknown;
}

export async function readPackageInfo(): Promise<PackageInfo> {
  const packageJsonUrl = new URL('../../package.json', import.meta.url);
  const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as PackageJsonShape;

  if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
    throw new Error('package.json must contain string name and version fields');
  }

  return {
    name: packageJson.name,
    version: packageJson.version,
  };
}
