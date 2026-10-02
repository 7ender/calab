export type Os = 'mac' | 'win' | 'linux';

type NavigatorUAData = Navigator & { userAgentData?: { platform?: string } };

/** Desktop OS of the visitor; null for phones, tablets, ChromeOS and anything unrecognised. */
export function detectOs(): Os | null {
  const nav = navigator as NavigatorUAData;
  const platform = (nav.userAgentData?.platform ?? '').toLowerCase();
  const ua = nav.userAgent;
  // iPadOS reports a Mac UA ("Macintosh") but has a touch screen.
  if (/Android|iPhone|iPad|iPod|CrOS/.test(ua) || platform === 'android' || platform === 'chrome os') return null;
  if (platform.startsWith('mac') || /Macintosh|Mac OS X/.test(ua)) return nav.maxTouchPoints > 1 ? null : 'mac';
  if (platform.startsWith('win') || ua.includes('Windows')) return 'win';
  if (platform === 'linux' || /Linux|X11/.test(ua)) return 'linux';
  return null;
}
