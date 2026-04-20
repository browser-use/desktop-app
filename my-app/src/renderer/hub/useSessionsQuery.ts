import { useQuery, useQueryClient, QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { AgentSession, HlEvent } from './types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

const SESSIONS_KEY = ['sessions'] as const;

export function useSessionsQuery() {
  const qc = useQueryClient();

  const query = useQuery<AgentSession[]>({
    queryKey: SESSIONS_KEY,
    queryFn: async () => {
      const t0 = performance.now();
      const api = window.electronAPI;
      if (!api) return [];
      const list = await api.sessions.list();
      const prev = qc.getQueryData<AgentSession[]>(SESSIONS_KEY) ?? [];
      const merged = list.map((s) => {
        const cached = prev.find((p) => p.id === s.id);
        if (cached && cached.output.length > 0 && s.output.length === 0) {
          return { ...s, output: cached.output };
        }
        return s;
      });
      console.log('[useSessionsQuery] fetched sessions', {
        total: merged.length,
        fetchMs: Math.round(performance.now() - t0),
      });
      return merged;
    },
  });

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const unsubUpdate = api.on.sessionUpdated((session) => {
      console.log('[useSessionsQuery] session-updated', { id: session.id, status: session.status, ts: Date.now() });
      qc.setQueryData<AgentSession[]>(SESSIONS_KEY, (prev = []) => {
        const idx = prev.findIndex((s) => s.id === session.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...prev[idx], ...session, hasBrowser: session.hasBrowser ?? prev[idx].hasBrowser };
          return next;
        }
        return [...prev, session];
      });
    });

    const unsubOutput = api.on.sessionOutput((id, event) => {
      console.log('[useSessionsQuery] session-output', { id, type: event.type });
      qc.setQueryData<AgentSession[]>(SESSIONS_KEY, (prev = []) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          return { ...s, output: [...s.output, event] };
        }),
      );
    });

    return () => {
      unsubUpdate();
      unsubOutput();
    };
  }, [qc]);

  return query;
}

export function useDismissSession() {
  const qc = useQueryClient();
  return (id: string) => {
    qc.setQueryData<AgentSession[]>(SESSIONS_KEY, (prev = []) =>
      prev.filter((s) => s.id !== id),
    );
  };
}

export function useUpdateSession() {
  const qc = useQueryClient();
  return (id: string, update: Partial<AgentSession>) => {
    qc.setQueryData<AgentSession[]>(SESSIONS_KEY, (prev = []) =>
      prev.map((s) => (s.id === id ? { ...s, ...update } : s)),
    );
  };
}

export function useHydrateSession(id: string | null) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!id) return;
    const api = window.electronAPI;
    if (!api) return;

    const cached = qc.getQueryData<AgentSession[]>(SESSIONS_KEY);
    const existing = cached?.find((s) => s.id === id);
    if (existing && existing.output.length > 0) return;

    api.sessions.get(id).then((full) => {
      if (!full || full.output.length === 0) return;
      qc.setQueryData<AgentSession[]>(SESSIONS_KEY, (prev = []) =>
        prev.map((s) => (s.id === id ? { ...s, output: full.output } : s)),
      );
    }).catch(() => {});
  }, [id, qc]);
}

export function useInvalidateSessions() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SESSIONS_KEY });
}

