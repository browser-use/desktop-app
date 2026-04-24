/**
 * Startup CLI-flag parsing helpers.
 *
 * Two flags are honored before any store is constructed:
 *
 *   --user-data-dir=<path>    Override userData directory
 *   --remote-debugging-port=<port>  Pick the CDP port exposed by Electron/Chromium
 *
 * Precedence (highest → lowest):
 *   1. CLI flag (`--user-data-dir=…`, `--remote-debugging-port=…`)
 *   2. Env var (`AGB_USER_DATA_DIR`)
 *   3. Default (userData: Electron's platform default; CDP port: 9222 so
 *      the Docker agent containers can reach `host.docker.internal:9222`)
 *
 * Kept as a standalone module so it can be unit-tested without booting Electron.
 */

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Extract a `--<flag>=<value>` or `--<flag> <value>` pair from an argv array.
 * Returns `null` when the flag is absent or the value is empty.
 */
export function extractFlagValue(argv: readonly string[], flag: string): string | null {
  const prefix = `--${flag}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith(prefix)) {
      const v = arg.slice(prefix.length);
      return v.length > 0 ? v : null;
    }
    if (arg === `--${flag}`) {
      const next = argv[i + 1];
      if (next !== undefined && next.length > 0 && !next.startsWith('-')) {
        return next;
      }
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// --user-data-dir
// ---------------------------------------------------------------------------

export interface ResolvedUserDataDir {
  value: string | null;
  /** One of 'cli' | 'env' | null — null means caller should leave default. */
  source: 'cli' | 'env' | null;
}

/**
 * Resolve the userData override with explicit precedence.
 *
 * - `--user-data-dir=<path>` on argv wins.
 * - Otherwise `AGB_USER_DATA_DIR` env var (dev fallback for start:fresh scripts).
 * - Otherwise returns `{ value: null, source: null }` so the caller preserves
 *   Electron's platform default.
 */
export function resolveUserDataDir(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): ResolvedUserDataDir {
  const cli = extractFlagValue(argv, 'user-data-dir');
  if (cli) return { value: cli, source: 'cli' };
  const envVal = env.AGB_USER_DATA_DIR;
  if (envVal && envVal.length > 0) return { value: envVal, source: 'env' };
  return { value: null, source: null };
}

// ---------------------------------------------------------------------------
// --remote-debugging-port
// ---------------------------------------------------------------------------

/** Start walking from the Chrome-convention port. If it's free, use it.
 *  If the user's Chrome is already there (the bug that prompted this fix),
 *  step up one port at a time until we find an unused slot. Predictable for
 *  firewall rules and docs, resilient against Chrome-on-9222 collision. */
const DEFAULT_START_PORT = 9222;
/** Sanity cap so a broken port-probe doesn't spin forever; in practice
 *  the first attempt almost always succeeds. */
const MAX_PORT_WALK = 500;

export interface ResolvedCdpPort {
  /**
   * Port Electron will advertise via `remote-debugging-port`. `0` means
   * Chromium will pick a free port at runtime — the real value has to be
   * discovered from stdout / `/json/version` after launch.
   */
  port: number;
  /** Provenance of the port.
   *   - 'cli'      → --remote-debugging-port=<N> on argv
   *   - 'env'      → AGB_CDP_PORT env var
   *   - 'walk'     → started at DEFAULT_START_PORT, first free port wins
   *   - 'fallback' → the walk hit MAX_PORT_WALK; we returned the start port
   *                  as a last resort and verifyCdpOwnership will surface
   *                  any collision. */
  source: 'cli' | 'env' | 'walk' | 'fallback';
  /** When source === 'walk', how many ports we skipped before finding one.
   *  0 means DEFAULT_START_PORT was free on first try. Used in startup logs
   *  to spot chronic collisions without needing a separate metric. */
  walkedFrom?: number;
}

/**
 * Resolve the CDP remote-debugging port.
 *
 * - `--remote-debugging-port=<N>` on argv wins (dev / power-user override).
 * - `AGB_CDP_PORT=<N>` env var second (CI / Docker pinning).
 * - Otherwise walk up from DEFAULT_START_PORT (9222) until we find a free
 *   port. Keeps the port predictable for firewall configs while avoiding
 *   collision with a user's own Chrome that already bound 9222.
 */
export function resolveCdpPort(argv: readonly string[]): ResolvedCdpPort {
  const raw = extractFlagValue(argv, 'remote-debugging-port');
  if (raw !== null) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 65535 && String(n) === raw) {
      return { port: n, source: 'cli' };
    }
    // Fall through to env / walk on a bogus value rather than crashing.
  }
  const envVal = process.env.AGB_CDP_PORT;
  if (envVal) {
    const n = Number.parseInt(envVal, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 65535 && String(n) === envVal) {
      return { port: n, source: 'env' };
    }
  }
  for (let i = 0; i < MAX_PORT_WALK; i++) {
    const p = DEFAULT_START_PORT + i;
    if (p > 65535) break;
    if (isPortFreeSync(p)) {
      return { port: p, source: 'walk', walkedFrom: i };
    }
  }
  return { port: DEFAULT_START_PORT, source: 'fallback' };
}

/**
 * Synchronously check whether a TCP port is already bound on localhost.
 *
 * Uses the OS's native listing command because Node's `net.createServer`
 * is async and we need a blocking answer before `app.commandLine.appendSwitch`
 * runs. `lsof` on POSIX and `netstat` on Windows are installed by default
 * and resolve in ~20ms, so walking a handful of ports is barely perceptible
 * at startup.
 *
 * On any error we return `true` (= port is free). Being optimistic on probe
 * failure keeps startup moving; verifyCdpOwnership() post-boot catches a
 * real collision and logs loudly.
 */
function isPortFreeSync(port: number): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('netstat', ['-an'], { encoding: 'utf8', timeout: 2000 });
      if (res.status !== 0 || !res.stdout) return true;
      const needle = `:${port} `;
      return !res.stdout
        .split(/\r?\n/)
        .some((line) => line.includes(needle) && /LISTENING/i.test(line));
    }
    const res = spawnSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-n', '-P'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    // lsof exits 1 when there are no matches — treat as "free".
    if (res.status !== 0) return true;
    return (res.stdout ?? '').trim().length === 0;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Module-level shared CDP port
// ---------------------------------------------------------------------------
//
// TabManager and src/main/chrome/ipc.ts both need the CDP port that was
// announced to Electron. They live in separate modules that can't easily
// import from index.ts without creating a cycle, so we stash the resolved
// port here and expose a getter.
//
// index.ts calls setAnnouncedCdpPort() immediately after appending the
// --remote-debugging-port switch; consumers call getAnnouncedCdpPort() at
// use-time. When `port === 0` (OS-assigned) consumers must fall back to
// runtime discovery via `/json/version`.
// ---------------------------------------------------------------------------

// Sentinel until setAnnouncedCdpPort is called at startup. Zero is valid for
// "OS-assigned" too; consumers that see 0 must discover the actual port via
// /json/version rather than use 0 as a TCP port.
let announcedCdpPort: number = 0;

export function setAnnouncedCdpPort(port: number): void {
  announcedCdpPort = port;
}

export function getAnnouncedCdpPort(): number {
  return announcedCdpPort;
}

// ---------------------------------------------------------------------------
// CDP ownership verification
// ---------------------------------------------------------------------------

/**
 * Probe http://127.0.0.1:<port>/json/version and confirm the Browser field
 * looks like an Electron instance (not the user's Chrome). Used at startup
 * to catch port collisions that would otherwise silently hand the agent the
 * wrong CDP endpoint.
 *
 * Returns { ok: true } when Browser starts with 'Electron/', { ok: false }
 * otherwise. Caller is responsible for logging + surfacing errors.
 */
export async function verifyCdpOwnership(port: number, timeoutMs = 2000): Promise<{ ok: boolean; browser?: string; error?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('node:http') as typeof import('node:http');
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(buf) as { Browser?: string };
            const browser = parsed.Browser ?? 'unknown';
            const ok = browser.startsWith('Electron/');
            resolve({ ok, browser });
          } catch (err) {
            resolve({ ok: false, error: `parse failed: ${(err as Error).message}` });
          }
        });
      },
    );
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}
