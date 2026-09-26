'use client';

import { Download } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Dict } from '@/i18n';
import { DOWNLOADS, LATEST_URL, REPO_URL } from '@/lib/site';
import { Button } from './ui';

type Os = 'mac' | 'win' | 'linux';

type Labels = Dict['downloads']['primary'];

const primary = (
  t: Labels,
): Record<Os, { label: string; href: string; alt?: { text: string; label: string; href: string } }> => ({
  mac: {
    label: t.mac,
    href: DOWNLOADS.macArm64,
    alt: { text: t.macIntel, label: t.macIntelLabel, href: DOWNLOADS.macX64 },
  },
  win: { label: t.win, href: DOWNLOADS.win },
  linux: {
    label: t.linux,
    href: DOWNLOADS.appImage,
    alt: { text: '.deb', label: t.linuxDebLabel, href: DOWNLOADS.deb },
  },
});

type NavigatorUAData = Navigator & { userAgentData?: { platform?: string } };

/** Desktop OS of the visitor; null for phones, tablets, ChromeOS and anything unrecognised. */
function detectOs(): Os | null {
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

const noSubscribe = () => () => undefined;

/**
 * The main download button: the installer for the visitor's OS (macOS / Apple Silicon when unknown and
 * in the static HTML), a direct link to the stable latest/ name, plus the release number from
 * latest/VERSION (omitted if it cannot be read).
 */
export function DownloadPrimary({ t }: { t: Labels }) {
  const os = useSyncExternalStore(noSubscribe, detectOs, () => null) ?? 'mac';
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${LATEST_URL}/VERSION`, { cache: 'no-cache', signal: ctrl.signal })
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        const v = text.trim();
        if (/^\d+\.\d+\.\d+$/.test(v)) setVersion(v);
      })
      .catch(() => undefined);
    return () => {
      ctrl.abort();
    };
  }, []);

  const p = primary(t)[os];
  return (
    <div className="mt-12 flex flex-col items-center gap-3 sm:mt-16">
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
        <Button href={p.href}>
          <Download aria-hidden="true" className="size-4" strokeWidth={2} />
          {p.label}
        </Button>
        {p.alt && (
          <a href={p.alt.href} aria-label={p.alt.label} className="link text-[15px] leading-6">
            {p.alt.text}
          </a>
        )}
      </div>
      <p className="text-[14px] leading-5 text-fg-2">
        {version && (
          <>
            {t.version} {version} ·{' '}
          </>
        )}
        <a href={`${REPO_URL}/releases`} className="link">
          {t.allVersions}
        </a>
      </p>
    </div>
  );
}
