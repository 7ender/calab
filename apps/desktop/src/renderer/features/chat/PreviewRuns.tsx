import { Fragment, type ReactNode } from 'react';
import type { PreviewPart } from '../../lib/markdown/parse';

/**
 * A one-line message preview (reply quote, pinned bar, DM list): text as is, code — inline or a
 * block squeezed to one line, without the fences — in the monospace font (docs/08, «Код в сообщениях»).
 */
export function PreviewRuns({ parts }: { parts: PreviewPart[] }): ReactNode {
  return parts.map((p, i) =>
    p.code ? (
      <code key={i} className="font-mono text-[0.92em]">
        {p.v}
      </code>
    ) : (
      <Fragment key={i}>{p.v}</Fragment>
    ),
  );
}
