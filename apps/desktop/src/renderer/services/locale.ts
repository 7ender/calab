import { MAIN_STRING_KEYS, type MainStrings } from '../../shared/ipc';
import { detectLocale, resolveLocale, setLocale, subscribeLocale, t, type Locale } from '../i18n';
import { log } from '../lib/log';
import { platform } from '../platform';
import { prefs, usePrefs } from '../stores/prefs';

/**
 * UI language wiring (ADR-0022): saved choice (`prefs.locale`) → OS languages → the ADR rule.
 * Electron asks main (`app.getLocale()` + the system list, via `app.info`); the web reads
 * `navigator.languages`. Started before the first render so the app never flashes Russian.
 */
let system: Promise<string[]> | null = null;

function systemLanguages(): Promise<string[]> {
  system ??= platform.app.info().then(
    (i) => (i.locales.length ? i.locales : [...navigator.languages]),
    () => [...navigator.languages],
  );
  return system;
}

/** The language the OS asks for (what «Как в системе» resolves to). */
export async function systemLocale(): Promise<Locale> {
  return detectLocale(await systemLanguages());
}

async function apply(pref: ReturnType<typeof prefs>['locale']): Promise<void> {
  try {
    await setLocale(resolveLocale(pref, pref === 'auto' ? await systemLanguages() : []));
  } catch (e) {
    log.warn('locale switch failed', e);
  }
}

/** Every MainStrings key is `main.<key>` in the dictionaries (tray, notifications, macOS menu). */
function pushMainStrings(): void {
  const s = Object.fromEntries(MAIN_STRING_KEYS.map((k) => [k, t(`main.${k}`)])) as unknown as MainStrings;
  platform.app.setStrings(s);
}

let started = false;

export async function startLocale(): Promise<void> {
  if (started) return;
  started = true;
  await apply(prefs().locale);
  pushMainStrings();
  subscribeLocale(pushMainStrings);
  usePrefs.subscribe((s, prev) => {
    if (s.locale !== prev.locale) void apply(s.locale);
  });
}
