/**
 * mv3/constants.ts — Manifest V3 runtime constants.
 */

export const MV3_LOG_PREFIX = 'MV3Runtime';

export const MANIFEST_VERSION_2 = 2;
export const MANIFEST_VERSION_3 = 3;

export const SERVICE_WORKER_IDLE_TIMEOUT_MS = 30_000;
export const SERVICE_WORKER_MAX_LIFETIME_MS = 5 * 60 * 1000;

export const DNR_RULE_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
] as const;

export type DnrResourceType = (typeof DNR_RULE_RESOURCE_TYPES)[number];

export const DNR_ACTION_TYPES = [
  'block',
  'redirect',
  'allow',
  'upgradeScheme',
  'modifyHeaders',
  'allowAllRequests',
] as const;

export type DnrActionType = (typeof DNR_ACTION_TYPES)[number];

export const BLOCKED_REMOTE_SCHEMES = ['http:', 'https:', 'ftp:', 'data:'] as const;

export const ACTION_API_METHODS = [
  'setIcon',
  'setTitle',
  'setPopup',
  'setBadgeText',
  'setBadgeBackgroundColor',
  'setBadgeTextColor',
  'enable',
  'disable',
  'isEnabled',
  'getTitle',
  'getPopup',
  'getBadgeText',
  'getBadgeBackgroundColor',
  'getBadgeTextColor',
  'getUserSettings',
  'openPopup',
] as const;
