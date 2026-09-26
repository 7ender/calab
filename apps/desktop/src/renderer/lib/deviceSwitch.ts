/**
 * «Микрофон: AirPods» / «Вывод: Динамики MacBook» (docs/09 #49): which audio device the call
 * uses changed because of the OS — a headset was plugged in or out, the system default moved,
 * the chosen device vanished (we fall back to the default) or came back. Pure: the caller
 * diffs two `enumerateDevices()` snapshots around a `devicechange` event with the current
 * choice from the settings (a pick in the settings changes the choice, not the device list,
 * so it never shows up here).
 */

export interface AudioDevice {
  deviceId: string;
  groupId: string;
  kind: 'audioinput' | 'audiooutput';
  label: string;
}

export interface DeviceChoice {
  /** null = follow the system default. */
  micDeviceId: string | null;
  outputDeviceId: string | null;
}

export interface DeviceSwitch {
  kind: 'input' | 'output';
  /** Human device name (no «Default - » prefix, no USB id suffix). */
  label: string;
}

/** Only the audio entries of an `enumerateDevices()` answer. */
export function audioDevices(list: readonly Pick<MediaDeviceInfo, 'deviceId' | 'groupId' | 'kind' | 'label'>[]): AudioDevice[] {
  return list
    .filter((d): d is typeof d & { kind: AudioDevice['kind'] } => d.kind === 'audioinput' || d.kind === 'audiooutput')
    .map((d) => ({ deviceId: d.deviceId, groupId: d.groupId, kind: d.kind, label: d.label }));
}

/** Chromium: pseudo-entries that alias a physical device («Default - X», Windows «Communications - X»). */
const ALIAS_IDS = new Set(['default', 'communications']);
const ALIAS_PREFIX = /^(?:default|communications|по умолчанию|связь)\s+-\s+/i;
/** Chromium appends the USB vendor:product id: «Logitech USB Headset (046d:0a8f)». */
const USB_SUFFIX = /\s+\([0-9a-f]{4}:[0-9a-f]{4}\)$/i;

export function deviceName(label: string): string {
  return label.replace(ALIAS_PREFIX, '').replace(USB_SUFFIX, '').trim();
}

/**
 * The device a call uses for `kind`: the chosen one while it is present, else the system
 * default (Chromium's «default» entry; browsers without it put the default first).
 */
export function activeDevice(list: readonly AudioDevice[], kind: AudioDevice['kind'], chosen: string | null): AudioDevice | null {
  const of = list.filter((d) => d.kind === kind);
  const picked = chosen ? of.find((d) => d.deviceId === chosen) : undefined;
  return picked ?? of.find((d) => d.deviceId === 'default') ?? of.find((d) => !ALIAS_IDS.has(d.deviceId)) ?? of[0] ?? null;
}

/**
 * Toasts to show after a device-list change. Nothing when either side is unknown: no device of
 * that kind (the call's own error handling speaks then) or no labels yet (no media permission —
 * e.g. the first snapshot before joining, when revealing the labels is not a switch).
 */
export function deviceSwitches(prev: readonly AudioDevice[], next: readonly AudioDevice[], choice: DeviceChoice): DeviceSwitch[] {
  const out: DeviceSwitch[] = [];
  const kinds = [
    ['audioinput', 'input', choice.micDeviceId],
    ['audiooutput', 'output', choice.outputDeviceId],
  ] as const;
  for (const [kind, name, chosen] of kinds) {
    const before = activeDevice(prev, kind, chosen);
    const after = activeDevice(next, kind, chosen);
    if (!before || !after) continue;
    const a = deviceName(before.label);
    const b = deviceName(after.label);
    if (!a || !b || a === b) continue;
    out.push({ kind: name, label: b });
  }
  return out;
}
