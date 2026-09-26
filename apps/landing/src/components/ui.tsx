import type { ReactNode } from 'react';

const cx = (...c: (string | false | undefined)[]): string => c.filter(Boolean).join(' ');

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('mx-auto w-full max-w-[1120px] px-4 sm:px-6', className)}>{children}</div>;
}

export function Section({
  id,
  labelledBy,
  alt,
  children,
}: {
  id: string;
  labelledBy: string;
  alt?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cx('py-20 sm:py-28', alt && 'surface-alt bg-bg-alt')}>
      <Container>{children}</Container>
    </section>
  );
}

export function SectionHeading({ id, eyebrow, title, lead }: { id: string; eyebrow: string; title: string; lead?: string }) {
  return (
    <div className="mx-auto max-w-[720px] text-center">
      <p className="text-[15px] leading-5 font-semibold text-accent-text">{eyebrow}</p>
      <h2 id={id} className="mt-2 text-[32px] leading-10 font-semibold tracking-tight text-balance sm:text-[44px] sm:leading-[52px]">
        {title}
      </h2>
      {lead && <p className="mt-4 text-[17px] leading-7 text-pretty text-fg-2 sm:text-[19px] sm:leading-8">{lead}</p>}
    </div>
  );
}

type ButtonProps = {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  size?: 'md' | 'sm';
  className?: string;
  external?: boolean;
};

export function Button({ href, children, variant = 'primary', size = 'md', className, external }: ButtonProps) {
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener' } : {})}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap',
        'motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out',
        size === 'md' ? 'h-11 px-6 text-[17px]' : 'h-8 px-4 text-[14px]',
        variant === 'primary'
          ? 'bg-accent-strong text-white hover:bg-accent-strong-hover active:bg-accent-strong-hover'
          : 'bg-accent-tint text-accent-text hover:bg-[color-mix(in_srgb,var(--color-accent-tint),var(--color-accent)_8%)]',
        className,
      )}
    >
      {children}
    </a>
  );
}

/**
 * Light/dark screenshot pair switched by prefers-color-scheme. Sources are 2x (Retina) captures;
 * `<name>-<theme>@2x.webp` is the full-resolution file, `<name>-<theme>.webp` a 1x Lanczos resample.
 * width/height are CSS pixels (half of the 2x pixel size).
 */
export function ThemedImage({
  name,
  alt,
  width,
  height,
  priority,
  className,
}: {
  name: string;
  alt: string;
  width: number;
  height: number;
  priority?: boolean;
  className?: string;
}) {
  const set = (theme: 'dark' | 'light') => `/screens/${name}-${theme}.webp 1x, /screens/${name}-${theme}@2x.webp 2x`;
  return (
    <picture>
      <source srcSet={set('dark')} media="(prefers-color-scheme: dark)" />
      <img
        src={`/screens/${name}-light@2x.webp`}
        srcSet={set('light')}
        alt={alt}
        width={width}
        height={height}
        decoding="async"
        {...(priority ? { fetchPriority: 'high' as const } : { loading: 'lazy' as const })}
        className={cx('block h-auto w-full', className)}
      />
    </picture>
  );
}
