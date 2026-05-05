import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCliSpawn } from '../../../src/main/hl/engines/pathEnrich';

const onWindows = process.platform === 'win32';

const MULTILINE_PROMPT = [
  'You are driving a specific Chromium browser view on this machine.',
  'Your target is CDP target_id=abc123 on port 9222.',
  'Read `./AGENTS.md` for how to drive the browser in this harness.',
  '',
  'Task: start google',
].join('\n');

describe.skipIf(!onWindows)('codex stdin path on Windows', () => {
  it('round-trips a multi-line prompt through a .cmd shim without word-splitting', async () => {
    // realpathSync.native expands 8.3 short names like C:\Users\RUNNER~1
    // (which os.tmpdir returns on GitHub Actions Windows runners) to the
    // canonical long form. Short names work in most APIs but `~` can confuse
    // batch-file redirect parsing in some shells/locales.
    const tmpRaw = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stdin-'));
    const tmp = fs.realpathSync.native(tmpRaw);
    const argvOut = path.join(tmp, 'argv.txt');
    const stdinOut = path.join(tmp, 'stdin.txt');

    // The shim uses `more` (not `findstr`) to capture stdin: findstr returns
    // exit code 1 when the input lacks a trailing newline. `more` always
    // exits 0. Trailing `exit /b 0` is belt-and-suspenders.
    const shim = path.join(tmp, 'codex.cmd');
    fs.writeFileSync(
      shim,
      [
        '@echo off',
        `(for %%A in (%*) do @echo %%A) > "${argvOut}"`,
        `more > "${stdinOut}"`,
        'exit /b 0',
      ].join('\r\n'),
      'utf-8',
    );

    const env = { ...process.env, Path: `${tmp};${process.env.Path ?? ''}` };
    const resolved = resolveCliSpawn('codex', ['exec', '--json', '--yolo', '-'], { env, platform: 'win32' });
    expect(resolved.viaCmdShell).toBe(true);

    let stdoutBuf = '';
    let stderrBuf = '';
    const exitCode = await new Promise<number | null>((resolveSpawn, rejectSpawn) => {
      const child = spawn(resolved.command, resolved.args, { env, cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], ...resolved.spawnOptions });
      child.stdout.on('data', (c: Buffer) => { stdoutBuf += c.toString('utf-8'); });
      child.stderr.on('data', (c: Buffer) => { stderrBuf += c.toString('utf-8'); });
      child.on('error', rejectSpawn);
      child.on('close', (code) => resolveSpawn(code));
      child.stdin.end(MULTILINE_PROMPT, 'utf-8');
    });

    // Surface diagnostics in the failure message so future regressions
    // (cmd.exe quoting, path-with-spaces, missing `more`) are debuggable
    // without re-running the job.
    const diag = `\nspawn: ${resolved.command} ${JSON.stringify(resolved.args)}\nexit: ${exitCode}\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}\ntmp: ${tmp}`;
    expect(fs.existsSync(argvOut), `argv file not created${diag}`).toBe(true);
    expect(fs.existsSync(stdinOut), `stdin file not created${diag}`).toBe(true);

    const argv = fs.readFileSync(argvOut, 'utf-8').trim().split(/\r?\n/);
    expect(argv).toEqual(['exec', '--json', '--yolo', '-']);

    const stdinSeen = fs.readFileSync(stdinOut, 'utf-8').replace(/\r\n/g, '\n').replace(/\n$/, '');
    expect(stdinSeen).toBe(MULTILINE_PROMPT);
    expect(stdinSeen.split('\n').length).toBeGreaterThan(1);
  });
});
