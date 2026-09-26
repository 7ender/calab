import { memo, type ReactNode } from 'react';
import { isSafeHref, parseMarkdown, type MdNode } from './parse';
import { platform } from '../../platform';

function open(href: string): void {
  if (isSafeHref(href)) void platform.app.openExternal(href);
}

function render(nodes: MdNode[], mention: MentionRenderer, key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text':
        return n.v;
      case 'br':
        return <br key={k} />;
      case 'code':
        return (
          <code key={k} className="rounded bg-code px-1 py-px font-mono text-[0.88em]">
            {n.v}
          </code>
        );
      case 'codeblock':
        return (
          <pre key={k} className="my-1 max-w-full overflow-x-auto rounded-md border border-line bg-code p-2.5 font-mono text-[12.5px] leading-snug">
            <code>{n.v}</code>
          </pre>
        );
      case 'b':
        return <strong key={k}>{render(n.c, mention, `${k}.`)}</strong>;
      case 'i':
        return <em key={k}>{render(n.c, mention, `${k}.`)}</em>;
      case 's':
        return <s key={k}>{render(n.c, mention, `${k}.`)}</s>;
      case 'link':
        return (
          <a
            key={k}
            href={n.href}
            title={n.href}
            onClick={(e) => {
              e.preventDefault();
              open(n.href);
            }}
            className="text-accent-text hover:underline"
          >
            {render(n.c, mention, `${k}.`)}
          </a>
        );
      case 'mention':
        return mention(n.v, k);
      default:
        return null;
    }
  });
}

/** Renders a mention node (`v`: user id, 'everyone' or 'here'); the caller knows the names. */
export type MentionRenderer = (v: string, key: string) => ReactNode;

export const Markdown = memo(function Markdown({ text, mention }: { text: string; mention: MentionRenderer }): ReactNode {
  return <>{render(parseMarkdown(text), mention)}</>;
});
