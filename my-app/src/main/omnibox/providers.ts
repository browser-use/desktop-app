/**
 * providers.ts — shared types for the omnibox autocomplete system.
 *
 * OmniboxSuggestion is the canonical result type returned by all
 * providers (history, bookmarks, open tabs, shortcuts) and consumed
 * by the renderer's URL-bar dropdown.
 */

export type SuggestionType =
  | 'history'
  | 'bookmark'
  | 'tab'
  | 'shortcut'
  | 'search'
  | 'did-you-mean';

export interface OmniboxSuggestion {
  /** Unique key for React rendering (provider:id). */
  id: string;
  type: SuggestionType;
  /** Primary display text (title or description). */
  title: string;
  /** Destination URL or search query. */
  url: string;
  /** Secondary line shown below title (elided URL, hostname, etc.). */
  description?: string;
  /** Data-URI or absolute URL for the favicon (optional). */
  favicon?: string;
  /** Relative relevance score used for ranking (higher = better). */
  relevance: number;
}
