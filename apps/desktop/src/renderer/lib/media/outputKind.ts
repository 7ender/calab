/**
 * «Does this output look like loudspeakers?» — by the device label only (ADR-0052: the stronger
 * musician-mode warning). A heuristic: labels are free text of the OS / driver. Headphone-ish
 * words win over speaker-ish ones («Headset Speakers», «Наушники (Realtek)»), and anything
 * unknown (a Bluetooth box named «JBL Flip 6», HDMI, an interface) is 'unknown' — the regular
 * headphones warning is shown then.
 */
export type OutputKind = 'speakers' | 'headphones' | 'unknown';

const HEADPHONES = /head(phone|set)|ear(phone|bud|pod)|airpods|buds|наушник|гарнитур|auricular|casque|kopfhörer|耳机/i;
const SPEAKERS = /speaker|built-?in output|internal speakers|динамик|колонк|встроенн|altavoz|haut-parleur|lautsprecher|扬声器/i;

export function outputKind(label: string): OutputKind {
  const l = label.trim();
  if (!l) return 'unknown';
  if (HEADPHONES.test(l)) return 'headphones';
  if (SPEAKERS.test(l)) return 'speakers';
  return 'unknown';
}

/**
 * The label of the output voice plays on: the chosen device, or the system default (Chromium lists
 * it as «Default - MacBook Pro Speakers»; the prefix is dropped). Empty when unknown (no labels
 * before a capture permission, or the device is gone).
 */
export function outputLabel(devices: readonly Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[], chosenId: string | null): string {
  const outs = devices.filter((d) => d.kind === 'audiooutput');
  const hit = (chosenId ? outs.find((d) => d.deviceId === chosenId) : undefined) ?? outs.find((d) => d.deviceId === 'default') ?? outs[0];
  return (hit?.label ?? '').replace(/^(default|по умолчанию)\s*[-–—:]\s*/i, '').trim();
}
