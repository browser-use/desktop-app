/**
 * Electron apps launched from a GUI often inherit a minimal PATH that excludes
 * user-installed CLIs. macOS is the worst case (Dock/Finder omit Homebrew,
 * Volta, asdf, etc.), but Windows can also expose PATH as `Path` instead of
 * `PATH`, and Linux desktop launchers may miss ~/.local/bin.
 *
 * `enrichedPath()` returns a platform-delimited PATH string that adds common
 * user-level binary directories on top of whatever PATH the process was given.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type Platform = NodeJS.Platform;

interface EnrichOptions {
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

/**
 * Spawn the user's login shell once and capture its PATH. Catches custom
 * dirs set in ~/.zshrc / ~/.bashrc / chruby / mise / asdf / etc. that
 * hard-coded lists can never anticipate.
 *
 * Cached for process lifetime — shells take 50–200 ms and we don't want
 * to pay that on every probe.
 */
let cachedShellPath: string | null = null;
let cachedShellPathTried = false;

function queryLoginShellPath(env: NodeJS.ProcessEnv = process.env, platform: Platform = process.platform): string | null {
  if (platform === 'win32') return null;
  if (cachedShellPathTried) return cachedShellPath;
  cachedShellPathTried = true;
  const sh = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  try {
    // -i (interactive) so aliases/function-setting init files run;
    // -l (login) so profile files like .zprofile / .bash_profile run.
    // `echo -n` avoids a trailing newline we'd then have to strip.
    const r = spawnSync(sh, ['-ilc', 'printf %s "$PATH"'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.length > 0) {
      cachedShellPath = r.stdout.trim();
    }
  } catch { /* ignore — fall through to hardcoded list */ }
  return cachedShellPath;
}

const POSIX_EXTRA_DIRS_FNS: Array<(home: string, platform: Platform, pathMod: typeof path) => string | null> = [
  () => '/opt/homebrew/bin',
  () => '/opt/homebrew/sbin',
  () => '/usr/local/bin',
  () => '/usr/local/sbin',
  (home, _platform, pathMod) => pathMod.join(home, '.npm-global', 'bin'),
  (home, _platform, pathMod) => pathMod.join(home, '.volta', 'bin'),
  (home, _platform, pathMod) => pathMod.join(home, '.nvm', 'versions', 'node'),
  (home, _platform, pathMod) => pathMod.join(home, '.bun', 'bin'),
  (home, _platform, pathMod) => pathMod.join(home, '.bcode', 'bin'),
  (home, _platform, pathMod) => pathMod.join(home, '.deno', 'bin'),
  (home, _platform, pathMod) => pathMod.join(home, '.cargo', 'bin'),
  (home, _platform, pathMod) => pathMod.join(home, '.local', 'bin'),
  (home, _platform, pathMod) => pathMod.join(home, '.yarn', 'bin'),
  (home, _platform, pathMod) => pathMod.join(home, 'bin'),
];

const WINDOWS_EXTRA_DIRS_FNS: Array<(home: string, env: NodeJS.ProcessEnv, pathMod: typeof path.win32) => string | null> = [
  (_home, env, pathMod) => env.LOCALAPPDATA ? pathMod.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin') : null,
  (_home, env, pathMod) => env.LOCALAPPDATA ? pathMod.join(env.LOCALAPPDATA, 'Programs', 'cursor', 'resources', 'app', 'bin') : null,
  (_home, env, pathMod) => env.LOCALAPPDATA ? pathMod.join(env.LOCALAPPDATA, 'Programs', 'Windsurf', 'resources', 'app', 'bin') : null,
  (home, _env, pathMod) => pathMod.join(home, 'AppData', 'Roaming', 'npm'),
  (home, _env, pathMod) => pathMod.join(home, '.bun', 'bin'),
  (home, _env, pathMod) => pathMod.join(home, '.deno', 'bin'),
  (home, _env, pathMod) => pathMod.join(home, '.cargo', 'bin'),
];

function pathValueFromEnv(env: NodeJS.ProcessEnv, platform: Platform): string {
  if (platform === 'win32') return env.Path ?? env.PATH ?? '';
  return env.PATH ?? '';
}

function pathKeyForEnv(env: NodeJS.ProcessEnv, platform: Platform): 'PATH' | 'Path' {
  if (platform === 'win32' && Object.prototype.hasOwnProperty.call(env, 'Path')) return 'Path';
  return 'PATH';
}

export function enrichedPath(base = pathValueFromEnv(process.env, process.platform), opts: EnrichOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? os.homedir();
  const pathMod = platform === 'win32' ? path.win32 : path;
  const delimiter = platform === 'win32' ? ';' : ':';
  const existing = base.split(delimiter).filter(Boolean);
  const set = new Set(existing);
  const out = [...existing];

  // First: anything the user's login shell knows about on POSIX — covers
  // custom setups like chruby, asdf, mise, direnv, or ad-hoc PATH exports.
  const shellPath = queryLoginShellPath(env, platform);
  if (shellPath) {
    for (const dir of shellPath.split(delimiter).filter(Boolean)) {
      if (!set.has(dir)) {
        set.add(dir);
        out.push(dir);
      }
    }
  }

  // Second: a conservative safety net of common binary dirs in case the
  // shell query failed or the platform has no login-shell convention.
  const extraFns = platform === 'win32'
    ? WINDOWS_EXTRA_DIRS_FNS.map((fn) => () => fn(home, env, pathMod))
    : POSIX_EXTRA_DIRS_FNS.map((fn) => () => fn(home, platform, pathMod));
  for (const fn of extraFns) {
    const dir = fn();
    if (dir && !set.has(dir)) {
      set.add(dir);
      out.push(dir);
    }
  }
  return out.join(delimiter);
}

export function enrichedEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const platform = process.platform;
  const key = pathKeyForEnv(baseEnv, platform);
  return { ...baseEnv, [key]: enrichedPath(pathValueFromEnv(baseEnv, platform), { platform, env: baseEnv }) };
}

/**
 * Windows CreateProcess can't execute `.cmd` / `.bat` shims directly — it only
 * runs true `.exe` files. npm-installed CLIs (like `codex`) ship as `.cmd`
 * shims with no `.exe`, so a plain `spawn('codex', …)` returns ENOENT (-4058)
 * even though the command works fine in any shell.
 *
 * `resolveCliSpawn` finds the actual file the OS would run (PATHEXT order),
 * and if it's a `.cmd`/`.bat`, rewrites the call to go through `cmd.exe` with
 * `/d /s /c` so each user-supplied arg stays a separate argv element. This is
 * safer than `shell: true`, which would word-split prompts containing spaces
 * or quotes.
 *
 * On non-Windows platforms it's a no-op (returns the inputs unchanged).
 */
const WIN_SHIM_EXTS = ['.cmd', '.bat'] as const;

function findOnWindowsPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathStr = pathValueFromEnv(env, 'win32');
  if (!pathStr) return null;
  const dirs = pathStr.split(';').filter(Boolean);
  // PATHEXT is the canonical search order. We always check `.exe` first so
  // a native binary wins over an npm shim with the same stem.
  const pathExt = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()).filter(Boolean);
  const exts = name.includes('.') && pathExt.includes(path.win32.extname(name).toLowerCase())
    ? ['']
    : pathExt;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.win32.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not here, keep looking */ }
    }
  }
  return null;
}

/** Quote one arg the way `cmd.exe` expects when it parses `/c "<cmdline>"`. */
function quoteForCmdExe(arg: string): string {
  if (arg === '') return '""';
  // If no whitespace and no cmd metacharacters, no quoting needed.
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  // Escape embedded double-quotes by doubling them, then wrap in quotes.
  return '"' + arg.replace(/"/g, '""') + '"';
}

export interface ResolvedCli {
  command: string;
  args: string[];
  /** True iff we rewrote the call to go through cmd.exe. */
  viaCmdShell: boolean;
}

export function resolveCliSpawn(
  name: string,
  args: readonly string[],
  opts: { platform?: Platform; env?: NodeJS.ProcessEnv } = {},
): ResolvedCli {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { command: name, args: [...args], viaCmdShell: false };

  const env = opts.env ?? enrichedEnv();
  const resolved = findOnWindowsPath(name, env);
  if (!resolved) return { command: name, args: [...args], viaCmdShell: false };

  const ext = path.win32.extname(resolved).toLowerCase();
  if (!WIN_SHIM_EXTS.includes(ext as (typeof WIN_SHIM_EXTS)[number])) {
    // Native .exe (or .com) — spawn it directly. Use the resolved absolute
    // path so we're not at the mercy of PATH ordering at exec time.
    return { command: resolved, args: [...args], viaCmdShell: false };
  }

  // .cmd / .bat: route through cmd.exe. Each token is quoted independently
  // and joined into ONE string after `/c`, which is the form cmd.exe expects.
  const cmdline = [resolved, ...args].map(quoteForCmdExe).join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', cmdline],
    viaCmdShell: true,
  };
}
