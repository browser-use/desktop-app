import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  extractHostname,
  getFaviconUrl,
  isDefaultFavicon,
  sortDomains,
} from '../shared/domain-utils';

const MAX_VISIBLE_DOMAINS = 2000;
const SEARCH_DEBOUNCE_MS = 80;

interface SessionCookie {
  domain: string;
}

interface Props {
  listCookies: () => Promise<SessionCookie[]>;
}

function fuzzyMatch(query: string, candidate: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (c.includes(q)) return true;
  let qi = 0;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function normalizeDomain(domain: string): string {
  return domain.startsWith('.') ? domain.slice(1) : domain;
}

export function OnboardingCookieList({ listCookies }: Props): React.ReactElement {
  const [cookies, setCookies] = useState<SessionCookie[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [defaultFaviconDomains, setDefaultFaviconDomains] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLoading(true);
    listCookies()
      .then((list) => setCookies(list))
      .catch((err) => console.error('[OnboardingCookieList] listCookies failed', err))
      .finally(() => setLoading(false));
  }, [listCookies]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const handleFaviconLoad = useCallback((domain: string, isDefault: boolean) => {
    if (!isDefault) return;
    setDefaultFaviconDomains((prev) => {
      if (prev.has(domain)) return prev;
      const next = new Set(prev);
      next.add(domain);
      return next;
    });
  }, []);

  const domainGroups = useMemo(() => {
    const seen = new Set<string>();
    for (const c of cookies) {
      const d = normalizeDomain(c.domain);
      if (d) seen.add(d);
    }
    return sortDomains(Array.from(seen), defaultFaviconDomains);
  }, [cookies, defaultFaviconDomains]);

  const filteredDomains = useMemo(() => {
    if (!debouncedSearch) return domainGroups;
    return domainGroups.filter((d) => fuzzyMatch(debouncedSearch, d));
  }, [domainGroups, debouncedSearch]);

  const visibleDomains = filteredDomains.slice(0, MAX_VISIBLE_DOMAINS);

  return (
    <div className="ob-cookies">
      <div className="ob-cookies__search">
        <svg className="ob-cookies__search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M9.5 9.5l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          className="ob-cookies__search-input"
          type="text"
          placeholder="Search domains (e.g. github)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button
            type="button"
            className="ob-cookies__search-clear"
            onClick={() => setSearch('')}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      <div className="ob-cookies__list" role="list">
        {loading && cookies.length === 0 ? (
          <div className="ob-cookies__empty">Reading cookies…</div>
        ) : visibleDomains.length === 0 ? (
          <div className="ob-cookies__empty">
            {cookies.length === 0 ? 'No cookies imported.' : 'No domains match your filter.'}
          </div>
        ) : (
          visibleDomains.map((d) => (
            <DomainRow key={d} domain={d} onFaviconLoad={handleFaviconLoad} />
          ))
        )}
      </div>
    </div>
  );
}

function DomainRow({
  domain,
  onFaviconLoad,
}: {
  domain: string;
  onFaviconLoad: (domain: string, isDefault: boolean) => void;
}): React.ReactElement {
  const [showFallback, setShowFallback] = useState(false);
  const hostname = extractHostname(domain);

  const handleLoad = async (event: React.SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    const isDefault = await isDefaultFavicon(img);
    onFaviconLoad(domain, isDefault);
  };

  const handleError = () => {
    setShowFallback(true);
    onFaviconLoad(domain, true);
  };

  return (
    <div className="ob-cookies__row" role="listitem" title={domain}>
      <span className="ob-cookies__icon">
        {showFallback ? (
          <span className="ob-cookies__icon-fallback" aria-hidden="true">
            {hostname.charAt(0).toUpperCase()}
          </span>
        ) : (
          <img
            src={getFaviconUrl(domain)}
            alt=""
            width={16}
            height={16}
            onLoad={handleLoad}
            onError={handleError}
          />
        )}
      </span>
      <span className="ob-cookies__hostname">{hostname}</span>
    </div>
  );
}
