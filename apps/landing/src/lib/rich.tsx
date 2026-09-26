import { Fragment, type ReactNode } from 'react';

/**
 * Replaces `{name}` placeholders of a dictionary string with React nodes (links, <code>), so translations
 * can move the placeholder within the sentence. Unknown placeholders are left as text.
 */
export function rich(text: string, parts: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((chunk, i) => {
    const key = /^\{(\w+)\}$/.exec(chunk)?.[1];
    return <Fragment key={i}>{key !== undefined && key in parts ? parts[key] : chunk}</Fragment>;
  });
}

/** Plain-text `{name}` substitution. */
export const fmt = (text: string, params: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
