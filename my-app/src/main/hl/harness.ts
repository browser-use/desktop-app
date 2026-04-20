import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { app } from 'electron';
import { mainLogger } from '../logger';

const REPO_URL = 'https://github.com/browser-use/harnessless.git';

export function getHarnessDir(): string {
  return path.join(app.getPath('userData'), 'harness');
}

export function ensureHarness(): string {
  const dir = getHarnessDir();

  if (fs.existsSync(path.join(dir, 'helpers.py'))) {
    mainLogger.info('harness.ensureHarness.exists', { dir });
    return dir;
  }

  mainLogger.info('harness.ensureHarness.cloning', { dir, repo: REPO_URL });
  try {
    execSync(`git clone --depth 1 ${REPO_URL} "${dir}"`, {
      timeout: 30_000,
      stdio: 'pipe',
    });
    mainLogger.info('harness.ensureHarness.cloned', { dir });
  } catch (err) {
    mainLogger.error('harness.ensureHarness.cloneFailed', { error: (err as Error).message });
    throw new Error(`Failed to clone harnessless: ${(err as Error).message}`);
  }

  return dir;
}

export function updateHarness(): boolean {
  const dir = getHarnessDir();
  if (!fs.existsSync(path.join(dir, '.git'))) return false;

  try {
    execSync('git stash && git pull --rebase && git stash pop', {
      cwd: dir,
      timeout: 15_000,
      stdio: 'pipe',
    });
    mainLogger.info('harness.updateHarness.success', { dir });
    return true;
  } catch (err) {
    mainLogger.warn('harness.updateHarness.failed', { error: (err as Error).message });
    return false;
  }
}
