import { t } from '../i18n';
import type { DeviceSwitch } from '../lib/deviceSwitch';
import { useToasts } from '../stores/toasts';
import { useUi } from '../stores/ui';

/** Short: it confirms something that already happened (docs/09 #49). */
export const DEVICE_TOAST_MS = 3000;

/** One switch can be seen twice (the capture ending + `devicechange`): the same text once per window. */
const DEDUPE_MS = 5000;
const recent = new Map<string, number>();

/** «Микрофон: AirPods» (green, 3 s) with «Изменить» → Settings → «Голос и устройства». */
export function announceDeviceSwitch(sw: DeviceSwitch, now = Date.now()): void {
  const key = `${sw.kind}:${sw.label}`;
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return;
  recent.set(key, now);
  const text = t(sw.kind === 'input' ? 'core.device.mic' : 'core.device.output', { name: sw.label });
  useToasts.getState().push(
    'success',
    text,
    { label: t('core.device.change'), run: () => useUi.getState().openDialog({ kind: 'settings', tab: 'voice' }) },
    DEVICE_TOAST_MS,
  );
}
