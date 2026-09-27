/**
 * The OS languages for the renderer's locale detection (ADR-0022), most preferred first.
 *
 * `app.getLocale()` is Chromium's UI locale: it follows `--lang` (tests pin it to ru), but for an
 * OS language without a Chromium UI pack it silently falls back to en-US — and the packaged app
 * ships only our languages' packs (electron-builder.yml `electronLanguages`). That fallback must
 * not outrank the real OS list: a de+ru system has to resolve to ru, uk/be/kk to ru, as before.
 * So Chromium's locale goes first only when `--lang` set it or it is one of the OS languages.
 */
export function systemLocales(chromiumLocale: string, preferred: readonly string[], langSwitch: boolean): string[] {
  const primary = (tag: string): string => tag.toLowerCase().split(/[-_]/)[0] ?? '';
  const own = langSwitch || preferred.length === 0 || preferred.some((t) => primary(t) === primary(chromiumLocale));
  return own ? [chromiumLocale, ...preferred] : [...preferred, chromiumLocale];
}
