import type { Sound } from '@calaba/protocol';
import { ArrowDown, ArrowUp, Play, Plus, Trash2, Upload } from 'lucide-react';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Empty, IconButton, Input } from '../../components/ui';
import { getLocale, t } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api, uploadFile, uploadPath } from '../../lib/api/endpoints';
import { log } from '../../lib/log';
import { previewSound } from '../../services/soundboard';
import { reportPlanError } from '../../services/plan';
import { useSounds, useWorkspaceSounds } from '../../stores/sounds';
import { toast } from '../../stores/toasts';
import { EmojiPicker } from '../chat/EmojiPicker';
import { CommitInput } from '../settings/CommitInput';

/** At most this many per workspace (server sounds.MaxSounds). */
export const MAX_SOUNDS = 50;
/** The upload the server converts: MP3 / WAV / Ogg, at most 2 MB (files.MaxSoundSourceBytes). */
export const MAX_SOUND_UPLOAD = 2 * 1024 * 1024;
const NAME_MAX = 32;
const ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave,audio/ogg,audio/opus,.mp3,.wav,.ogg,.oga,.opus';
const DEFAULT_EMOJI = '🔊';

/** A sound name from a file name: «ba_dum-tss.mp3» → «ba dum tss», at most 32 characters. */
export function soundNameFromFile(file: string): string {
  const base = file
    .replace(/\.[^.]*$/u, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return Array.from(base).slice(0, NAME_MAX).join('') || 'sound';
}

const seconds = (ms: number): string => t('snd.seconds', { n: (ms / 1000).toLocaleString(getLocale(), { maximumFractionDigits: 1 }) });

async function upload(workspaceId: string, file: File): Promise<string> {
  const meta = await uploadFile(uploadPath(workspaceId, ''), file, file.name, () => undefined).promise;
  return meta.id;
}

/**
 * «Настройки пространства → Звуки» (ADR-0036 §3, docs/08 «Саундборд»; MANAGE_STICKERS): the
 * workspace's soundboard. «Добавить звук» → a file (MP3 / WAV / Ogg ≤ 2 MB; the server makes a
 * 5 s Ogg/Opus clip at −16 LUFS) with an emoji and a name; the list — ▶, emoji and name changed
 * in place, «Заменить файл», up / down, delete with a confirmation. Changes reach everyone at once.
 */
export function SoundsTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const list = useWorkspaceSounds(workspaceId);
  const [draft, setDraft] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const full = list.length >= MAX_SOUNDS;
  const pick = (f: File): void => {
    if (f.size > MAX_SOUND_UPLOAD) {
      toast.info(t('snd.tooBig'));
      return;
    }
    setDraft(f);
  };
  const add = (
    <Button onClick={() => input.current?.click()} disabled={full || !!draft} data-testid="sound-add">
      <Plus className="size-4" aria-hidden /> {t('snd.add')}
    </Button>
  );
  return (
    <>
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-caption text-muted">{full ? t('snd.limit', { n: MAX_SOUNDS }) : t('snd.hint')}</p>
        {list.length > 0 ? add : null}
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) pick(f);
        }}
      />
      {draft ? <NewSound workspaceId={workspaceId} file={draft} onDone={() => setDraft(null)} /> : null}
      {list.length > 0 ? (
        <Card title={t('snd.count', { n: list.length, max: MAX_SOUNDS })}>
          {list.map((s, i) => (
            <SoundRow key={s.id} workspaceId={workspaceId} sound={s} index={i} last={i === list.length - 1} />
          ))}
        </Card>
      ) : draft ? null : (
        <Empty action={add}>{t('snd.empty')}</Empty>
      )}
    </>
  );
}

/** The emoji of a sound as a 28 px chip; a click opens the emoji picker. */
function EmojiChip({ value, onPick }: { value: string; onPick: (v: string) => void }): ReactNode {
  return (
    <EmojiPicker label={t('snd.emoji')} onPick={(e) => e !== value && onPick(e)} closeOnPick inModal side="top">
      <button
        type="button"
        aria-label={t('snd.emoji')}
        data-testid="sound-emoji"
        className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-fill)] text-[16px] leading-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent data-[state=open]:outline-2 data-[state=open]:outline-accent"
      >
        {value || DEFAULT_EMOJI}
      </button>
    </EmojiPicker>
  );
}

/** «Новый звук»: ▶ of the chosen file, its emoji and name, «Отмена» / «Добавить» (upload, then create). */
function NewSound({ workspaceId, file, onDone }: { workspaceId: string; file: File; onDone: () => void }): ReactNode {
  const [name, setName] = useState(() => soundNameFromFile(file.name));
  const [emoji, setEmoji] = useState(DEFAULT_EMOJI);
  const [busy, setBusy] = useState(false);
  const [url] = useState(() => URL.createObjectURL(file));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const trimmed = name.trim();
  const submit = async (): Promise<void> => {
    if (!trimmed) return;
    setBusy(true);
    try {
      const fileId = await upload(workspaceId, file);
      const r = await api.sounds.create(workspaceId, { name: trimmed, emoji, fileId });
      if (r.sound) useSounds.getState().upsert(r.sound);
      onDone();
    } catch (e) {
      log.warn('sound upload', e);
      if (!reportPlanError(e, workspaceId)) toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('snd.new')}>
      <form
        className="flex items-center gap-2 px-3 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* A local file: a plain <audio> element (never WebAudio, docs/02). */}
        <IconButton label={t('snd.previewFile')} onClick={() => void new Audio(url).play().catch(() => undefined)}>
          <Play className="size-4" aria-hidden />
        </IconButton>
        <EmojiChip value={emoji} onPick={setEmoji} />
        <Input
          aria-label={t('snd.name')}
          placeholder={t('snd.namePlaceholder')}
          value={name}
          maxLength={NAME_MAX}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onDone();
            }
          }}
          className="min-w-0 flex-1"
        />
        <Button type="button" variant="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" busy={busy} disabled={!trimmed} data-testid="sound-create">
          {t('snd.create')}
        </Button>
      </form>
    </Card>
  );
}

/** One sound: ▶, emoji, name (in place), duration, «Заменить файл», up / down, delete. */
const SoundRow = memo(function SoundRow({ workspaceId, sound, index, last }: { workspaceId: string; sound: Sound; index: number; last: boolean }): ReactNode {
  const replaceInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const update = async (init: Parameters<typeof api.sounds.update>[2]): Promise<void> => {
    try {
      const r = await api.sounds.update(workspaceId, sound.id, init);
      if (r.sound) useSounds.getState().upsert(r.sound);
    } catch (e) {
      if (!reportPlanError(e, workspaceId)) toast.error(errorText(e));
    }
  };
  const replace = async (f: File): Promise<void> => {
    if (f.size > MAX_SOUND_UPLOAD) {
      toast.info(t('snd.tooBig'));
      return;
    }
    setBusy(true);
    try {
      await update({ fileId: await upload(workspaceId, f) });
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('snd.deleteTitle', { name: sound.name }), t('snd.deleteText'), t('common.delete')))) return;
    try {
      await api.sounds.remove(workspaceId, sound.id);
      useSounds.getState().remove(workspaceId, sound.id);
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  return (
    <div className="flex min-h-12 items-center gap-2 px-3 py-2" data-testid="sound-row">
      <IconButton label={t('snd.preview', { name: sound.name })} onClick={() => previewSound(sound.id)}>
        <Play className="size-4" aria-hidden />
      </IconButton>
      <EmojiChip value={sound.emoji} onPick={(emoji) => void update({ emoji })} />
      <div className="min-w-0 flex-1">
        <CommitInput label={t('snd.name')} value={sound.name} maxLength={NAME_MAX} onCommit={(name) => (name ? update({ name }) : undefined)} className="w-full max-w-64" />
      </div>
      <span className="shrink-0 text-caption tabular-nums text-muted">{seconds(sound.durationMs)}</span>
      <input
        ref={replaceInput}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void replace(f);
        }}
      />
      <IconButton label={t('snd.replace')} disabled={busy} onClick={() => replaceInput.current?.click()}>
        <Upload className="size-4" aria-hidden />
      </IconButton>
      <IconButton label={t('snd.up')} disabled={index === 0} onClick={() => void update({ position: index - 1 })}>
        <ArrowUp className="size-4" aria-hidden />
      </IconButton>
      <IconButton label={t('snd.down')} disabled={last} onClick={() => void update({ position: index + 1 })}>
        <ArrowDown className="size-4" aria-hidden />
      </IconButton>
      <IconButton label={t('snd.delete')} className="text-muted hover:text-danger" onClick={() => void remove()}>
        <Trash2 className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
});
