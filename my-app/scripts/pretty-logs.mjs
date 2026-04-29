#!/usr/bin/env node

import readline from 'node:readline';

const args = process.argv.slice(2);
const mode = readArg('--mode') ?? 'all';
const sessionFilter = readArg('--session');
const useColor = process.env.LOG_COLOR
  ? process.env.LOG_COLOR !== '0'
  : process.env.FORCE_COLOR
  ? process.env.FORCE_COLOR !== '0'
  : !process.env.NO_COLOR;

process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

function readArg(name) {
  const prefix = `${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

function color(code, text) {
  const value = String(text);
  return useColor ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function dim(text) { return color('2', text); }
function bold(text) { return color('1', text); }

const channelColors = {
  browser: '36',
  engine: '33',
  main: '34',
  renderer: '35',
};

function channelColor(channel) {
  return channelColors[channel] ?? '37';
}

function levelColor(level) {
  const normalized = normalizeLevel(level);
  if (normalized === 'error') return '1;31';
  if (normalized === 'warn') return '1;33';
  if (normalized === 'debug') return '2';
  return '32';
}

function normalizeLevel(level) {
  if (typeof level === 'number') {
    if (level === 0 || level === 1) return 'debug';
    if (level === 2) return 'info';
    if (level === 3) return 'warn';
    return 'error';
  }
  return String(level ?? 'info').toLowerCase();
}

function timingEventColor(event) {
  const value = String(event);
  if (/fail|error/i.test(value)) return color('1;31', value);
  if (/finish|ready|navigate|resolved|exit/i.test(value)) return color('32', value);
  return color('37', value);
}

function ms(value) {
  return value == null ? '-' : `${value}ms`;
}

function metric(name, value, code) {
  return `${dim(`${name}=`)}${color(code, ms(value))}`;
}

function shortSession(sessionId) {
  return sessionId ? String(sessionId).slice(0, 8) : '';
}

function shouldPrint(entry) {
  if (sessionFilter && entry.sessionId !== sessionFilter) return false;
  if (mode === 'startup') {
    return entry.area === 'startup' || String(entry.msg ?? '').startsWith('BrowserPool.startup');
  }
  if (mode === 'navigation') {
    return entry.area === 'navigation' || String(entry.msg ?? '').startsWith('BrowserPool.navigation');
  }
  return true;
}

function formatStartup(entry) {
  return [
    dim(entry.ts ?? ''),
    color('36', 'startup'),
    timingEventColor(entry.event ?? entry.msg),
    metric('total', entry.msSinceSessionStart, '1;33'),
    metric('browser', entry.msSinceCreate, '34'),
    `${dim('url=')}${color('4', entry.url ?? '-')}`,
    dim(`session=${shortSession(entry.sessionId)}`),
  ].join(' ');
}

function formatNavigation(entry) {
  const url = entry.url ?? entry.validatedURL ?? '-';
  return [
    dim(entry.ts ?? ''),
    color('36', 'nav'),
    timingEventColor(entry.event ?? entry.msg),
    metric('total', entry.msSinceSessionStart, '1;33'),
    metric('browser', entry.msSinceBrowserCreate, '34'),
    metric('nav', entry.msSinceNavigationStart, '35'),
    `${dim('url=')}${color('4', url)}`,
    dim(`session=${shortSession(entry.sessionId)}`),
  ].join(' ');
}

function formatGeneric(entry) {
  const channel = String(entry.channel ?? 'log');
  const level = normalizeLevel(entry.level);
  const parts = [
    dim(entry.ts ?? ''),
    color(channelColor(channel), channel.padEnd(8)),
    color(levelColor(level), level.padEnd(5)),
    bold(entry.msg ?? ''),
  ];

  for (const [key, value] of usefulFields(entry)) {
    parts.push(`${dim(`${key}=`)}${formatValue(value, key)}`);
  }

  return parts.filter(Boolean).join(' ');
}

function usefulFields(entry) {
  const skip = new Set(['ts', 'level', 'channel', 'msg', 'area', 'event']);
  const noisy = new Set(['args', 'envAuthFlags']);
  const prioritized = [
    'sessionId',
    'engineId',
    'window',
    'message',
    'url',
    'validatedURL',
    'count',
    'total',
    'imported',
    'failed',
    'skipped',
    'code',
    'signal',
    'error',
    'reason',
    'line',
    'sourceId',
    'stderrTail',
    'stdoutTail',
  ];

  const output = [];
  const seen = new Set();
  for (const key of prioritized) {
    if (key in entry && !noisy.has(key)) {
      output.push([key, entry[key]]);
      seen.add(key);
    }
  }

  for (const [key, value] of Object.entries(entry)) {
    if (skip.has(key) || noisy.has(key) || seen.has(key)) continue;
    output.push([key, value]);
  }

  return output.filter(([, value]) => value !== '' && value != null).slice(0, 10);
}

function formatValue(value, key) {
  if (key === 'sessionId') return dim(shortSession(value));
  if (typeof value === 'string') return colorForValue(truncate(clean(value), key), key);
  if (typeof value === 'number' || typeof value === 'boolean') return color('37', value);
  return dim(truncate(JSON.stringify(value)));
}

function colorForValue(value, key) {
  if (key === 'error' || key === 'stderrTail') return color('31', value);
  if (key === 'message') return color('37', value);
  if (key === 'url' || key === 'validatedURL' || key === 'sourceId') return color('4', value);
  return color('37', value);
}

function clean(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value, max = 220) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function formatEntry(entry) {
  if (entry.area === 'startup' || String(entry.msg ?? '').startsWith('BrowserPool.startup')) {
    return formatStartup(entry);
  }
  if (entry.area === 'navigation' || String(entry.msg ?? '').startsWith('BrowserPool.navigation')) {
    return formatNavigation(entry);
  }
  return formatGeneric(entry);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (trimmed.startsWith('==>') && trimmed.endsWith('<==')) {
    console.log(color('2;36', trimmed.replace(/^==>\s*/, '').replace(/\s*<==$/, '')));
    return;
  }

  try {
    const entry = JSON.parse(trimmed);
    if (shouldPrint(entry)) console.log(formatEntry(entry));
  } catch {
    console.log(dim(trimmed));
  }
});
