import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { chromeProfileCandidates, runtimePaths, safeName } = require('../../harnessless/paths.js') as {
  chromeProfileCandidates: (opts?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
  }) => string[];
  runtimePaths: (opts?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    name?: string;
    runDir?: string;
  }) => {
    name: string;
    safeName: string;
    runDir: string;
    socketPath: string;
    logPath: string;
    pidPath: string;
  };
  safeName: (name: string) => string;
};

describe('harnessless paths', () => {
  it('sanitizes runtime names for filesystem and named-pipe paths', () => {
    expect(safeName('x/y:z')).toBe('x_y_z');
  });

  it('uses named pipes on Windows and temp files for log/pid state', () => {
    const paths = runtimePaths({
      platform: 'win32',
      name: 'x/y:z',
      runDir: 'C:\\Users\\Ada\\AppData\\Local\\Temp',
    });

    expect(paths.socketPath).toBe('\\\\.\\pipe\\browser-use-bh-x_y_z');
    expect(paths.logPath).toBe('C:\\Users\\Ada\\AppData\\Local\\Temp\\bh-x_y_z.log');
    expect(paths.pidPath).toBe('C:\\Users\\Ada\\AppData\\Local\\Temp\\bh-x_y_z.pid');
  });

  it('uses Unix sockets in the selected runtime directory on POSIX', () => {
    const paths = runtimePaths({
      platform: 'linux',
      name: 'default',
      runDir: '/run/user/501',
    });

    expect(paths.socketPath).toBe('/run/user/501/bh-default.sock');
    expect(paths.logPath).toBe('/run/user/501/bh-default.log');
    expect(paths.pidPath).toBe('/run/user/501/bh-default.pid');
  });

  it('discovers Windows Chrome profile roots from LOCALAPPDATA', () => {
    const candidates = chromeProfileCandidates({
      platform: 'win32',
      home: 'C:\\Users\\Ada',
      env: { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' },
    });

    expect(candidates).toContain('C:\\Users\\Ada\\AppData\\Local\\Google\\Chrome\\User Data');
    expect(candidates).toContain('C:\\Users\\Ada\\AppData\\Local\\Chromium\\User Data');
  });

  it('discovers Linux Chrome profile roots from XDG_CONFIG_HOME', () => {
    const candidates = chromeProfileCandidates({
      platform: 'linux',
      home: '/home/ada',
      env: { XDG_CONFIG_HOME: '/home/ada/.config' },
    });

    expect(candidates).toContain('/home/ada/.config/google-chrome');
    expect(candidates).toContain('/home/ada/.config/chromium');
  });
});
