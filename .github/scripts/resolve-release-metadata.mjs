#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function parseStableTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) {
    return null;
  }
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function revCommit(ref) {
  return git(['rev-list', '-n', '1', ref]);
}

function tagExists(tag) {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

function targetCommitFor(tag) {
  if (tagExists(tag)) {
    return revCommit(tag);
  }
  return revCommit(env('GITHUB_SHA', 'HEAD'));
}

function isAncestor(commit, targetCommit) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, targetCommit], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function resolveTag() {
  const ref = env('GITHUB_REF');
  if (ref.startsWith('refs/tags/')) {
    return ref.slice('refs/tags/'.length);
  }

  const inputTag = env('INPUT_TAG');
  if (inputTag) {
    return inputTag;
  }

  return `v0.0.0-dev-${env('GITHUB_RUN_ID', 'local')}`;
}

function resolvePreviousStableTag(tag) {
  const current = parseStableTag(tag);
  const targetCommit = targetCommitFor(tag);
  const tags = git(['tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseStableTag)
    .filter(Boolean)
    .filter((candidate) => candidate.tag !== tag)
    .map((candidate) => ({ ...candidate, commit: revCommit(candidate.tag) }))
    .filter((candidate) => isAncestor(candidate.commit, targetCommit));

  const candidates = current
    ? tags.filter((candidate) => compareVersions(candidate, current) < 0)
    : tags;

  candidates.sort(compareVersions);
  return candidates.at(-1)?.tag ?? '';
}

function setOutput(name, value) {
  const outputPath = env('GITHUB_OUTPUT');
  if (outputPath) {
    appendFileSync(outputPath, `${name}=${value}\n`);
  }
}

const tag = resolveTag();
const previousTag = resolvePreviousStableTag(tag);
const prerelease = /-(dev|rc|beta|alpha)/.test(tag);
const releaseName = `Browser Use Desktop ${tag}`;

setOutput('tag', tag);
setOutput('release_name', releaseName);
setOutput('previous_tag', previousTag);
setOutput('prerelease', String(prerelease));

console.log(`Resolved release tag: ${tag}`);
console.log(`Resolved release name: ${releaseName}`);
console.log(`Resolved previous stable tag: ${previousTag || '(none)'}`);
console.log(`Resolved prerelease: ${prerelease}`);
