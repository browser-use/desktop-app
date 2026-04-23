import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

// Use a hash-fragment prefix instead of a custom URL scheme. react-markdown's
// default URL sanitizer silently drops anchor tags whose href uses an unknown
// scheme like `bu-output:` (the `a` element comes through with no href, so
// the text renders as a plain `[label](url)` literal). `#…` is always treated
// as a same-page anchor and survives the sanitizer.
const OUTPUT_PATH_SCHEME = '#bu-output:';

/**
 * Wrap `outputs/<uuidish>/<file.ext>` substrings as markdown links with a
 * `bu-output:` href so the custom `a` renderer can turn them into
 * downloadOutput buttons. Safe to call on any string; no-op if no matches.
 */
export function linkifyOutputPaths(source: string): string {
  // Idempotent: if the source is already linkified (contains our scheme),
  // leave it alone. Avoids nesting brackets on repeat calls.
  if (source.includes(OUTPUT_PATH_SCHEME)) return source;
  const re = /\boutputs\/[a-zA-Z0-9_-]{6,}\/[^\s)\]"'`<>]+?\.[a-zA-Z0-9]+/g;
  return source.replace(re, (m) => `[${m}](${OUTPUT_PATH_SCHEME}${m})`);
}

const OUTPUT_PATH_RE = /\boutputs\/[a-zA-Z0-9_-]{6,}\/[^\s)\]"'`<>,;]+?\.[a-zA-Z0-9]+/g;

/**
 * Split text into React nodes, turning `outputs/<id>/<file>` substrings into
 * clickable `<a>` elements. Use this anywhere you want clickable paths
 * without going through Markdown (e.g., tool call/result previews where
 * the surrounding text may contain non-markdown characters that trip up
 * the markdown parser).
 */
export function linkifyPathsToReact(text: string): React.ReactNode[] {
  if (!text) return [text];
  // If the source already contains our markdown-link wrapping (e.g. from an
  // earlier render pass or Claude Code echoing our scheme back), strip it
  // down to bare paths first so the link ends up as a clean <a>, not
  // `[<link>](#bu-output:<link>)` literal brackets.
  const unwrapped = text.replace(
    /\[(outputs\/[^\]]+)\]\(#?bu-output:[^)]+\)/g,
    '$1',
  );
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(OUTPUT_PATH_RE.source, 'g');
  while ((m = re.exec(unwrapped)) !== null) {
    if (m.index > lastIndex) nodes.push(unwrapped.slice(lastIndex, m.index));
    const p = m[0];
    nodes.push(
      <a
        key={`p-${m.index}`}
        href="#"
        className="md-output-path"
        onClick={(e) => {
          e.preventDefault();
          window.electronAPI?.sessions?.downloadOutput?.(p).catch((err) => console.error('[linkify] download failed', err));
        }}
        title={`Open ${p}`}
      >{p}</a>,
    );
    lastIndex = m.index + p.length;
  }
  if (lastIndex < unwrapped.length) nodes.push(unwrapped.slice(lastIndex));
  return nodes.length === 0 ? [unwrapped] : nodes;
}

export function Markdown({
  source,
  variant = 'default',
}: {
  source: string;
  variant?: 'default' | 'compact';
}): React.ReactElement {
  return (
    <div className={`md${variant === 'compact' ? ' md--compact' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={(url) => {
          // Allow our custom `bu-output:` scheme through; react-markdown's
          // default sanitizer would otherwise strip it as an unknown protocol
          // and the link falls back to broken rendering.
          if (typeof url === 'string' && url.startsWith(OUTPUT_PATH_SCHEME)) return url;
          // For everything else use the default safe-URL policy.
          return url;
        }}
        components={{
          a: ({ node, href, children, ...props }) => {
            if (typeof href === 'string' && href.startsWith(OUTPUT_PATH_SCHEME)) {
              const relPath = href.slice(OUTPUT_PATH_SCHEME.length);
              const onClick = (e: React.MouseEvent) => {
                e.preventDefault();
                window.electronAPI?.sessions?.downloadOutput?.(relPath).catch((err) => {
                  console.error('[md] downloadOutput failed', err);
                });
              };
              return (
                <a
                  {...props}
                  href="#"
                  onClick={onClick}
                  className="md-output-path"
                  title={`Open ${relPath}`}
                >{children}</a>
              );
            }
            return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

export default Markdown;
