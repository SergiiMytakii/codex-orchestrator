import { readCanonicalText } from './mission-canonical-path.js';

export class MissionRepositoryObserver {
  public constructor(
    private readonly root: string,
    private readonly grantedPaths: string[],
    private readonly deniedPaths: string[],
  ) {}

  public async readText(path: string, maxBytes: number): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('Mission observation maxBytes must be a positive integer.');
    }
    return (await readCanonicalText({
      root: this.root,
      path,
      grantedPaths: this.grantedPaths,
      deniedPaths: this.deniedPaths,
      maxBytes,
    })).text;
  }
}
