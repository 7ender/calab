import { Smile } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Button, Input, Modal, Select } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { CLEAR_AFTER, clearAfterSeconds, type ClearAfter } from '../../services/presenceTimer';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { EmojiPicker } from '../chat/EmojiPicker';

/** PATCH /api/me/status (text + emoji + expiry); older servers only know PATCH /api/me {statusText}. */
export async function saveCustomStatus(s: { text: string; emoji: string; expiresInSeconds: number }): Promise<boolean> {
  try {
    const r = await api.me.setStatus(s).catch((e: unknown) => {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return api.me.update({ statusText: s.text });
      throw e;
    });
    if (r.me) useSession.getState().set({ me: r.me });
    return true;
  } catch (e) {
    toast.fail(e, t('err.ctx.save'));
    return false;
  }
}

/** Status menu → «Задать свой статус…» (docs/09 #29): emoji + text + «Очистить через». */
export function CustomStatusDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const user = useSession((s) => s.me?.user);
  const [text, setText] = useState(user?.statusText ?? '');
  const [emoji, setEmoji] = useState(user?.statusEmoji ?? '');
  const [after, setAfter] = useState<ClearAfter>('never');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const save = async (): Promise<void> => {
    const value = text.trim();
    setBusy(true);
    const ok = await saveCustomStatus({ text: value, emoji: value ? emoji : '', expiresInSeconds: value ? clearAfterSeconds(after, new Date()) : 0 });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('presence.customTitle')}
      initialFocus={field}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-1">
          <label className="text-caption font-medium text-muted" htmlFor="custom-status-text">
            {t('shell.statusText')}
          </label>
          <div className="flex items-center gap-2">
            <EmojiPicker label={t('presence.emoji')} onPick={setEmoji} closeOnPick>
              <button
                type="button"
                aria-label={t('presence.emoji')}
                className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-fill)] text-[16px] hover:bg-[var(--color-fill-hover)] mobile:size-10"
              >
                {emoji || <Smile className="size-4 text-muted" aria-hidden />}
              </button>
            </EmojiPicker>
            <Input
              id="custom-status-text"
              ref={field}
              value={text}
              maxLength={128}
              placeholder={t('shell.statusPh')}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-caption font-medium text-muted" htmlFor="custom-status-after">
            {t('presence.clearAfter')}
          </label>
          <Select id="custom-status-after" value={after} onChange={(e) => setAfter(e.target.value as ClearAfter)}>
            {CLEAR_AFTER.map((c) => (
              <option key={c.value} value={c.value}>
                {t(c.key)}
              </option>
            ))}
          </Select>
        </div>
      </form>
    </Modal>
  );
}
