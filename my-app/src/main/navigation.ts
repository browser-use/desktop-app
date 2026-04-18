/**
 * URL vs search query parsing.
 * Explicit scheme → use as-is
 * localhost / IP / bare domain → prepend https://
 * Otherwise → Google search
 */

const EXPLICIT_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i;
const LOCALHOST_RE = /^localhost(:\d+)?(\/.*)?$/i;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/;
const IP6_RE = /^\[[:0-9a-f]+\](:\d+)?(\/.*)?$/i;
const GOOGLE_SEARCH_BASE = 'https://www.google.com/search?q=';

export function parseNavigationInput(input: string): string {
  const trimmed = input.trim();

  if (EXPLICIT_URL_RE.test(trimmed)) {
    return trimmed;
  }

  if (BARE_DOMAIN_RE.test(trimmed) || LOCALHOST_RE.test(trimmed) || IP_RE.test(trimmed) || IP6_RE.test(trimmed)) {
    return \`https://\${trimmed}\`;
  }

  // host:port pattern (e.g. "myserver:8080")
  if (/^[a-z0-9.-]+:\d{1,5}(\/.*)?$/i.test(trimmed)) {
    return \`https://\${trimmed}\`;
  }

  return \`\${GOOGLE_SEARCH_BASE}\${encodeURIComponent(trimmed)}\`;
}
