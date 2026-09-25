import * as TooltipP from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Spinner } from '../components/ui';
import { AuthScreen } from '../features/auth/AuthScreen';
import { OfflineScreen, TooManySessions } from '../features/auth/SessionScreens';
import { AppShell } from '../features/shell/AppShell';
import { Dialogs } from '../features/shell/Dialogs';
import { Toasts } from '../features/shell/Toasts';
import { usePrefs } from '../stores/prefs';
import { useSession } from '../stores/session';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } },
});

function useTheme(): void {
  const theme = usePrefs((s) => s.theme);
  useEffect(() => {
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
      <TooltipP.Provider>
        {screen}
        {status === 'authed' ? <Dialogs /> : null}
        <Toasts />
      </TooltipP.Provider>
    </QueryClientProvider>
  );
}
