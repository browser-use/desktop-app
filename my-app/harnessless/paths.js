const os = require('os');
const path = require('path');

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function runtimePaths(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const name = opts.name || env.BU_NAME || 'default';
  const sanitized = safeName(name);
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const runDir = opts.runDir || env.BU_RUN_DIR || os.tmpdir();

  return {
    name,
    safeName: sanitized,
    runDir,
    socketPath: platform === 'win32'
      ? `\\\\.\\pipe\\browser-use-bh-${sanitized}`
      : pathMod.join(runDir, `bh-${sanitized}.sock`),
    logPath: pathMod.join(runDir, `bh-${sanitized}.log`),
    pidPath: pathMod.join(runDir, `bh-${sanitized}.pid`),
  };
}

function chromeProfileCandidates(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const pathMod = platform === 'win32' ? path.win32 : path.posix;

  if (platform === 'darwin') {
    return [
      pathMod.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      pathMod.join(home, 'Library', 'Application Support', 'Chromium'),
      pathMod.join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
    ];
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || pathMod.join(home, 'AppData', 'Local');
    return [
      pathMod.join(localAppData, 'Google', 'Chrome', 'User Data'),
      pathMod.join(localAppData, 'Google', 'Chrome SxS', 'User Data'),
      pathMod.join(localAppData, 'Chromium', 'User Data'),
    ];
  }

  const configHome = env.XDG_CONFIG_HOME || pathMod.join(home, '.config');
  return [
    pathMod.join(configHome, 'google-chrome'),
    pathMod.join(configHome, 'google-chrome-beta'),
    pathMod.join(configHome, 'google-chrome-unstable'),
    pathMod.join(configHome, 'chromium'),
  ];
}

module.exports = {
  chromeProfileCandidates,
  runtimePaths,
  safeName,
};
