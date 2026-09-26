import { useEffect, useState } from 'react';

/** `true` only after `value` has stayed true for `ms` (hides short blips, e.g. a deploy reconnect). */
export function useDelayed(value: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!value) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset immediately when the condition clears
      setOn(false);
      return;
    }
    const t = window.setTimeout(() => setOn(true), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return value && on;
}
