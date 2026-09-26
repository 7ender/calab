import type { ReactNode } from 'react';

/**
 * macOS-style window frame around a 1440×800 app snapshot. The snapshot already has the
 * hidden-inset title bar, so traffic lights are drawn into its empty top-left corner
 * (x = 20/40/60, y = 19, Ø12 at 1440 px — positioned in % to scale with the image).
 */
export function MacWindow({ children }: { children: ReactNode }) {
  const light = (left: number, color: string) => (
    <span
      className="absolute aspect-square rounded-full"
      style={{ left: `${((left - 6) / 1440) * 100}%`, top: `${((19 - 6) / 800) * 100}%`, width: `${(12 / 1440) * 100}%`, background: color }}
    />
  );
  return (
    <div className="relative overflow-hidden rounded-[12px] border border-line shadow-window">
      {children}
      <span aria-hidden="true">
        {light(20, '#ff5f57')}
        {light(40, '#febc2e')}
        {light(60, '#28c840')}
      </span>
    </div>
  );
}
