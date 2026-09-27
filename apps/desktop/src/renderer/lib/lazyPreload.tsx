import { Suspense, use, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { log } from './log';

/**
 * A component in its own chunk (docs/18 step 9: settings, admin, onboarding stay out of the
 * startup bundle). `preload()` fetches it ahead — on idle after READY and on hover of what opens
 * it — and a mount after that renders it directly, without a Suspense round. Otherwise the first
 * mount shows `fallback` until the chunk is in. The choice is made once per mount, so a mounted
 * tree never swaps. A failed load (a web deploy removed the old chunk) logs, calls the
 * component's `onClose` if it has one and is retried on the next mount; it never throws into the
 * tree (there is no error boundary above the dialogs).
 */
export function lazyPreload<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode = null,
): { Component: (props: P) => ReactNode; preload: () => Promise<ComponentType<P>> } {
  let ready: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  let failed = false;
  const preload = (): Promise<ComponentType<P>> =>
    (pending ??= load().then(
      (c) => (ready = c),
      (e: unknown) => {
        log.warn('chunk load failed', e);
        failed = true; // the promise stays (resolved to Failed) until the next mount retries
        return Failed as ComponentType<P>;
      },
    ));
  function Loaded(props: P): ReactNode {
    const C = use(preload());
    // Not created during render: the one memoized module export (or Failed), stable across renders.
    // eslint-disable-next-line react-hooks/static-components
    return <C {...props} />;
  }
  function Component(props: P): ReactNode {
    const [now] = useState(() => {
      if (failed) {
        failed = false;
        pending = null;
      }
      return ready;
    });
    if (now) {
      const C = now;
      return <C {...props} />;
    }
    return (
      <Suspense fallback={fallback}>
        <Loaded {...props} />
      </Suspense>
    );
  }
  return { Component, preload };
}

function Failed({ onClose }: { onClose?: () => void }): ReactNode {
  useEffect(() => onClose?.(), [onClose]);
  return null;
}

/** Runs `fn` when the renderer is idle (after the startup work), once. */
export function whenIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn, { timeout: 5000 });
    return () => cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 2000);
  return () => window.clearTimeout(id);
}
