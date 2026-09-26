import * as TooltipP from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Spinner } from '../components/ui';
import { AuthScreen } from '../features/auth/AuthScreen';
import { OfflineScreen, TooManySessions } from '../features/auth/SessionScreens';
import { AppShell } from '../features/shell/AppShell';
import { Dialogs } from '../features/shell/Dialogs';
import { Toasts } from '../features/shell/Toasts';
import { usePrefs } from '../stores/prefs';
import { queryClient } from '../lib/queryClient';
import { platform } from '../platform';
import { useSession } from '../stores/session';

export { queryClient };

function useTheme(): void {
  const theme = usePrefs((s) => s.theme);
  const os = useSession((s) => s.appInfo?.platform);
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  useEffect(() => {
    // macOS Electron: native vibrancy behind the sidebar + overlay scrollbars (docs/08).
    const root = document.documentElement;
    root.classList.toggle('mac', os === 'darwin' || /Mac OS X|Macintosh/.test(navigator.userAgent));
    root.classList.toggle('vibrancy', platform.kind === 'electron' && os === 'darwin' && !visualTest);
    root.classList.toggle('test-stable', visualTest);
  }, [os, visualTest]);
  useEffect(() => {
    platform.app.setTheme(theme); // the native material follows the app theme
    const apply = (): void => {
      const dark = theme === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : theme === 'dark';
      document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
    };
    apply();
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

export function App(): ReactNode {
  useTheme();
  const status = useSession((s) => s.status);
  const tooMany = useSession((s) => s.tooManySessions);
  let screen: ReactNode;
  if (status === 'booting')
    screen = (
      <div className="drag grid h-full place-items-center bg-side">
        <Spinner className="size-8" />
      </div>
    );
  else if (status === 'anon') screen = <AuthScreen />;
  else if (status === 'offline') screen = <OfflineScreen />;
  else if (tooMany) screen = <TooManySessions />;
  else screen = <AppShell />;
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipP.Provider delayDuration={400} skipDelayDuration={300}>
        {screen}
        {status === 'authed' ? <Dialogs /> : null}
        <Toasts />
      </TooltipP.Provider>
    </QueryClientProvider>
  );
}
