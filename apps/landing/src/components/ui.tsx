import type { ReactNode } from 'react';
import { preload } from 'react-dom';
import { LOCALE_INFO, type Locale } from '@/i18n/locales';
import { SCREENS, type ScreenName } from '@/lib/screens';

export const cx = (...c: (string | false | undefined)[]): string => c.filter(Boolean).join(' ');

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('mx-auto w-full max-w-[1200px] px-4 sm:px-6', className)}>{children}</div>;
}

export function Section({
  id,
  labelledBy,
  alt,
  children,
  className,
}: {
  id: string;
  labelledBy: string;
  alt?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cx('py-20 sm:py-28', alt && 'surface-alt bg-bg-alt', className)}>
      <Container>{children}</Container>
    </section>
  );
}

export function SectionHeading({ id, eyebrow, title, lead }: { id: string; eyebrow: string; title: string; lead?: string }) {
  return (
    <div className="mx-auto max-w-[760px] text-center">
      <p className="text-[15px] leading-5 font-semibold text-accent-text">{eyebrow}</p>
      <h2 id={id} className="mt-3 text-[32px] leading-10 font-semibold tracking-tight text-balance sm:text-[48px] sm:leading-[56px]">
        {title}
      </h2>
      {lead && <p className="mt-5 text-[17px] leading-7 text-pretty text-fg-2 sm:text-[19px] sm:leading-8">{lead}</p>}
    </div>
  );
}

type ButtonProps = {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  /** card: full height, tighter padding and 15 px text — two buttons side by side in a narrow card. */
  size?: 'lg' | 'md' | 'sm' | 'card';
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
        { lg: 'h-12 px-7 text-[17px]', md: 'h-11 px-6 text-[17px]', sm: 'h-8 px-4 text-[14px]', card: 'h-11 px-3 text-[15px]' }[size],
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
 * A screenshot of the app (landing v3, docs/09 #139): dark theme, the UI and the team in the page's
 * language (`public/screens/<lang>/<name>`). `<name>.webp` is 1x, `<name>@2x.webp` the full Retina
 * capture, `<name>-720.webp` a phone-sized file for crops wider than 720 px; `sizes` is the rendered width, so the browser picks by width descriptors (a phone never
 * fetches the 2x file of a shot shown at a third of its size). width/height are CSS pixels: no layout shift.
 */
export function Screen({
  name,
  locale,
  alt,
  sizes,
  priority,
  eager,
  className,
}: {
  name: ScreenName;
  locale: Locale;
  alt: string;
  sizes: string;
  /** The LCP image: loaded eagerly with high fetch priority. */
  priority?: boolean;
  /** Near the top of the page: loaded eagerly (a lazy image there stays empty during a fast scroll). */
  eager?: boolean;
  className?: string;
}) {
  const { width, height } = SCREENS[name];
  const base = `/screens/${LOCALE_INFO[locale].lang}/${name}`;
  const srcSet = `${width > 720 ? `${base}-720.webp 720w, ` : ''}${base}.webp ${width}w, ${base}@2x.webp ${width * 2}w`;
  // The LCP image starts loading from the <head> (a preload with the same srcset), not after layout.
  if (priority) preload(`${base}.webp`, { as: 'image', imageSrcSet: srcSet, imageSizes: sizes, fetchPriority: 'high' });
  return (
    <img
      src={`${base}.webp`}
      srcSet={srcSet}
      sizes={sizes}
      alt={alt}
      width={width}
      height={height}
      decoding="async"
      {...(priority ? { fetchPriority: 'high' as const } : eager ? {} : { loading: 'lazy' as const })}
      className={cx('block h-auto w-full', className)}
    />
  );
}

/** The app window around a screenshot: a solid dark frame, a hairline border, a soft shadow (no glass). */
export function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('shot-frame overflow-hidden rounded-[14px]', className)}>{children}</div>;
}
