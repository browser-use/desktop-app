#!/usr/bin/env node

import { writeFileSync } from 'node:fs';

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function requireEnv(name) {
  const value = env(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function apiHeaders() {
  const token = requireEnv('GITHUB_TOKEN');
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
}

async function githubApi(path, options = {}) {
  const response = await fetch(`https://api.github.com/${path}`, {
    ...options,
    headers: {
      ...apiHeaders(),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body}`);
  }
  return response.json();
}

async function generateGithubNotes(ownerRepo, tag, previousTag) {
  const payload = {
    tag_name: tag,
  };
  if (previousTag) {
    payload.previous_tag_name = previousTag;
  }

  const response = await githubApi(`repos/${ownerRepo}/releases/generate-notes`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return response.body || '';
}

function hasChangeEntries(body) {
  return body
    .split('\n')
    .some((line) => /^\s*[-*]\s+/.test(line) && !line.includes('/compare/'));
}

function displayAuthor(commit) {
  const login = commit.author?.login || commit.committer?.login;
  if (login) {
    return {
      key: login.toLowerCase(),
      label: `@${login}`,
    };
  }

  const name = commit.commit?.author?.name || commit.commit?.committer?.name || 'unknown';
  return {
    key: name.toLowerCase(),
    label: name,
  };
}

function firstLine(message) {
  return String(message || '').split('\n')[0].trim();
}

async function generateCompareNotes(ownerRepo, tag, previousTag) {
  if (!previousTag) {
    return `**Full Changelog**: https://github.com/${ownerRepo}/commits/${tag}\n`;
  }

  const range = `${encodeURIComponent(previousTag)}...${encodeURIComponent(tag)}`;
  const comparison = await githubApi(`repos/${ownerRepo}/compare/${range}`);
  const contributors = new Map();
  const lines = ['## What\'s Changed'];

  for (const commit of comparison.commits || []) {
    const title = firstLine(commit.commit?.message);
    if (!title) {
      continue;
    }
    const author = displayAuthor(commit);
    contributors.set(author.key, author.label);
    const shortSha = commit.sha.slice(0, 7);
    lines.push(`* ${title} by ${author.label} in [${shortSha}](${commit.html_url})`);
  }

  if (lines.length === 1) {
    lines.push('* No commits in this release range.');
  }

  if (contributors.size > 0) {
    lines.push('', '## Contributors');
    for (const contributor of contributors.values()) {
      lines.push(`* ${contributor}`);
    }
  }

  lines.push(
    '',
    `**Full Changelog**: https://github.com/${ownerRepo}/compare/${previousTag}...${tag}`,
    '',
  );
  return lines.join('\n');
}

const ownerRepo = requireEnv('GITHUB_REPOSITORY');
const tag = requireEnv('RELEASE_TAG');
const previousTag = env('PREVIOUS_TAG');
const outputPath = env('RELEASE_NOTES_PATH', 'release-notes.md');

const githubNotes = await generateGithubNotes(ownerRepo, tag, previousTag);
const notes = hasChangeEntries(githubNotes)
  ? githubNotes
  : await generateCompareNotes(ownerRepo, tag, previousTag);

writeFileSync(outputPath, notes.endsWith('\n') ? notes : `${notes}\n`);
console.log(`Wrote deterministic release notes to ${outputPath}`);
