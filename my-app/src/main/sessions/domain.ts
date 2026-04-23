const MULTI_PART_TLDS = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.nz', 'co.in', 'co.za', 'co.il',
  'com.br', 'com.au', 'com.mx', 'com.ar', 'com.tw', 'com.hk', 'com.sg',
  'ne.jp', 'or.jp', 'ac.uk', 'gov.uk', 'org.uk',
]);

export function extractRegistrableDomain(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    const m = url.match(/^[a-z]+:\/\/([^/?#]+)/i);
    if (!m) return null;
    host = m[1].toLowerCase();
  }
  if (!host) return null;
  if (host.startsWith('www.')) host = host.slice(4);

  const parts = host.split('.');
  if (parts.length < 2) return null;

  const lastTwo = parts.slice(-2).join('.');
  if (parts.length >= 3 && MULTI_PART_TLDS.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}
