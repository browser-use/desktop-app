/**
 * Telemetry metric emitter for The Browser.
 *
 * API:
 *   telemetry.observe('pill_open_latency_ms', 42)
 *   telemetry.increment('daemon_crash_count')
 *   telemetry.gauge('session_restore_success_rate', 0.99)
 *
 * In dev / opt-out mode: writes to local JSONL log at userData/telemetry.jsonl
 * In beta / opt-in mode: sends to PostHog (configured via POSTHOG_API_KEY env var)
 *
 * Thresholds are checked on every observe() call. Threshold violations are
 * logged to the structured logger and emitted as 'threshold-violation' events.
 *
 * Track H owns this file. Track A will import it from src/main/telemetry.ts.
 */

import { EventEmitter } from 'events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[Telemetry]';
const JSONL_FILENAME = 'telemetry.jsonl';
const MAX_HISTOGRAM_SAMPLES = 10_000;

// ---------------------------------------------------------------------------
// Metric thresholds (plan §8.4)
// ---------------------------------------------------------------------------

export interface MetricThreshold {
  p95?: number;
  p99?: number;
  max?: number;
  min?: number;
}

export const METRIC_THRESHOLDS: Record<string, MetricThreshold> = {
  pill_open_latency_ms:        { p95: 150, p99: 300 },
  agent_first_step_latency_ms: { p95: 3000 },
  agent_first_step_latency_ms_warm: { p95: 500 },
  daemon_startup_ms:           { p95: 3000 },
  daemon_crash_rate_per_session: { max: 0.01 },
  session_restore_success_rate:  { min: 0.99 },
  agent_task_success_rate:       { min: 0.80 },
  sandbox_violations_per_day:    { max: 5 },
  // histogram-only (no threshold alerts)
  agent_task_duration_ms: {},
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricKind = 'histogram' | 'counter' | 'gauge';

export interface MetricEntry {
  ts: string;       // ISO timestamp
  metric: string;
  kind: MetricKind;
  value: number;
  tags?: Record<string, string>;
}

export interface ThresholdViolation {
  metric: string;
  percentile?: string;
  threshold: number;
  actual: number;
}

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ---------------------------------------------------------------------------
// TelemetryEmitter
// ---------------------------------------------------------------------------

export class TelemetryEmitter extends EventEmitter {
  private readonly userDataPath: string;
  private readonly mode: 'local' | 'remote';

  /** Histogram storage: metric name → sorted sample array */
  private histograms = new Map<string, number[]>();

  /** Counter storage */
  private counters = new Map<string, number>();

  /** Gauge storage: most-recent value */
  private gauges = new Map<string, number>();

  /** Whether to flush to local JSONL */
  private localLogEnabled: boolean;
  private localLogPath: string;

  constructor(opts: {
    userDataPath?: string;
    mode?: 'local' | 'remote';
  } = {}) {
    super();

    // Default to ~/Library/Application Support/AgenticBrowser when running in
    // Electron; fall back to a temp dir when unit-tested outside Electron.
    this.userDataPath =
      opts.userDataPath ??
      (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { app } = require('electron');
          return app.getPath('userData');
        } catch {
          return path.join(os.tmpdir(), 'AgenticBrowser');
        }
      })();

    this.mode = opts.mode ?? (process.env['POSTHOG_API_KEY'] ? 'remote' : 'local');
    this.localLogEnabled = this.mode === 'local';
    this.localLogPath = path.join(this.userDataPath, JSONL_FILENAME);

    if (this.localLogEnabled) {
      fs.mkdirSync(this.userDataPath, { recursive: true });
    }

    console.log(
      `${LOG_PREFIX} Initialized mode=${this.mode} localLog=${this.localLogPath}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Record a histogram observation (latency, duration, etc.).
   * Checks p95/p99 thresholds after inserting.
   */
  observe(metric: string, value: number, tags?: Record<string, string>): void {
    console.log(`${LOG_PREFIX} observe metric=${metric} value=${value}`);

    // Insert into sorted histogram (insertion sort — fine for ≤10k samples)
    let samples = this.histograms.get(metric);
    if (!samples) {
      samples = [];
      this.histograms.set(metric, samples);
    }

    const insertIdx = this._sortedInsertIndex(samples, value);
    samples.splice(insertIdx, 0, value);

    // Trim if too large
    if (samples.length > MAX_HISTOGRAM_SAMPLES) {
      samples.shift();
    }

    this._writeLocal({ ts: new Date().toISOString(), metric, kind: 'histogram', value, tags });
    this._checkThresholds(metric, samples);
    this._maybeRemote(metric, 'histogram', value, tags);
  }

  /**
   * Increment a counter by delta (default 1).
   */
  increment(metric: string, delta = 1, tags?: Record<string, string>): void {
    const current = this.counters.get(metric) ?? 0;
    const next = current + delta;
    this.counters.set(metric, next);
    console.log(`${LOG_PREFIX} increment metric=${metric} delta=${delta} total=${next}`);
    this._writeLocal({ ts: new Date().toISOString(), metric, kind: 'counter', value: next, tags });
    this._maybeRemote(metric, 'counter', next, tags);
  }

  /**
   * Set a gauge value (rates, percentages).
   * Checks min/max thresholds.
   */
  gauge(metric: string, value: number, tags?: Record<string, string>): void {
    this.gauges.set(metric, value);
    console.log(`${LOG_PREFIX} gauge metric=${metric} value=${value}`);
    this._writeLocal({ ts: new Date().toISOString(), metric, kind: 'gauge', value, tags });
    this._checkGaugeThreshold(metric, value);
    this._maybeRemote(metric, 'gauge', value, tags);
  }

  // ---------------------------------------------------------------------------
  // Accessors (for tests and diagnostics)
  // ---------------------------------------------------------------------------

  getHistogram(metric: string): number[] {
    return [...(this.histograms.get(metric) ?? [])];
  }

  getCounter(metric: string): number {
    return this.counters.get(metric) ?? 0;
  }

  getGauge(metric: string): number | undefined {
    return this.gauges.get(metric);
  }

  getP95(metric: string): number {
    const samples = this.histograms.get(metric) ?? [];
    return percentile(samples, 95);
  }

  getP99(metric: string): number {
    const samples = this.histograms.get(metric) ?? [];
    return percentile(samples, 99);
  }

  /** Reset all state — useful in tests */
  reset(): void {
    this.histograms.clear();
    this.counters.clear();
    this.gauges.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private _sortedInsertIndex(arr: number[], val: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]! <= val) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private _checkThresholds(metric: string, samples: number[]): void {
    const thresholds = METRIC_THRESHOLDS[metric];
    if (!thresholds) return;

    if (thresholds.p95 !== undefined) {
      const p95val = percentile(samples, 95);
      if (p95val > thresholds.p95) {
        const violation: ThresholdViolation = {
          metric,
          percentile: 'p95',
          threshold: thresholds.p95,
          actual: p95val,
        };
        console.warn(
          `${LOG_PREFIX} THRESHOLD VIOLATION metric=${metric} p95=${p95val} > limit=${thresholds.p95}`,
        );
        this.emit('threshold-violation', violation);
      }
    }

    if (thresholds.p99 !== undefined) {
      const p99val = percentile(samples, 99);
      if (p99val > thresholds.p99) {
        const violation: ThresholdViolation = {
          metric,
          percentile: 'p99',
          threshold: thresholds.p99,
          actual: p99val,
        };
        console.warn(
          `${LOG_PREFIX} THRESHOLD VIOLATION metric=${metric} p99=${p99val} > limit=${thresholds.p99}`,
        );
        this.emit('threshold-violation', violation);
      }
    }
  }

  private _checkGaugeThreshold(metric: string, value: number): void {
    const thresholds = METRIC_THRESHOLDS[metric];
    if (!thresholds) return;

    if (thresholds.max !== undefined && value > thresholds.max) {
      const violation: ThresholdViolation = {
        metric,
        threshold: thresholds.max,
        actual: value,
      };
      console.warn(
        `${LOG_PREFIX} THRESHOLD VIOLATION metric=${metric} value=${value} > max=${thresholds.max}`,
      );
      this.emit('threshold-violation', violation);
    }

    if (thresholds.min !== undefined && value < thresholds.min) {
      const violation: ThresholdViolation = {
        metric,
        threshold: thresholds.min,
        actual: value,
      };
      console.warn(
        `${LOG_PREFIX} THRESHOLD VIOLATION metric=${metric} value=${value} < min=${thresholds.min}`,
      );
      this.emit('threshold-violation', violation);
    }
  }

  private _writeLocal(entry: MetricEntry): void {
    if (!this.localLogEnabled) return;
    try {
      fs.appendFileSync(this.localLogPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to write local telemetry: ${(err as Error).message}`);
    }
  }

  private _maybeRemote(
    metric: string,
    kind: MetricKind,
    value: number,
    tags?: Record<string, string>,
  ): void {
    if (this.mode !== 'remote') return;
    const apiKey = process.env['POSTHOG_API_KEY'];
    if (!apiKey) return;

    // PostHog capture — fire-and-forget with error suppression
    const body = JSON.stringify({
      api_key: apiKey,
      event: `metric.${metric}`,
      properties: { kind, value, ...tags },
      timestamp: new Date().toISOString(),
    });

    fetch('https://app.posthog.com/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch((err: unknown) => {
      console.error(`${LOG_PREFIX} PostHog send failed: ${(err as Error).message}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const telemetry = new TelemetryEmitter();
