import type { Sticker, StickerPack } from '@calaba/protocol';
import { ChevronLeft, ChevronRight, Plus, Star, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Empty, IconButton, Input, Row, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api, uploadStickers } from '../../lib/api/endpoints';
import { STICKER_BATCH, STICKER_MAX_ANIMATED, coverOf, looksLikeWebp } from '../../lib/stickers';
import { loadWorkspaceStickers } from '../../services/stickers';
import { reportPlanError } from '../../services/plan';
import { useStickers } from '../../stores/stickers';
import { CommitInput } from '../settings/CommitInput';
import { StickerImage } from '../chat/stickers/StickerImage';

/*
 * Workspace settings → «Стикеры» (ADR-0030, docs/08 «Стикеры»), MANAGE_STICKERS: the packs
 * (cover, name, count) and «Новый пак»; a pack card — rename, drop WebP files in a batch (each
 * gets an emoji before the upload), the stickers with their emoji, «Сделать обложкой», delete.
 * Changes apply at once; the server validates every file (a refusal shows inline).
 */

const err = (e: unknown): string => errorText(e);
const NO_PACKS: StickerPack[] = [];

export function StickersTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const packs = useStickers((s) => s.byWorkspace[workspaceId] ?? NO_PACKS);
  const loaded = useStickers((s) => workspaceId in s.byWorkspace);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    void loadWorkspaceStickers(workspaceId);
  }, [workspaceId]);
  const pack = open ? packs.find((p) => p.id === open) : undefined;
  if (pack) return <PackCard workspaceId={workspaceId} pack={pack} onBack={() => setOpen(null)} />;
  return <PackList workspaceId={workspaceId} packs={packs} loaded={loaded} onOpen={setOpen} />;
}

function PackList({ workspaceId, packs, loaded, onOpen }: { workspaceId: string; packs: StickerPack[]; loaded: boolean; onOpen: (id: string) => void }): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (): Promise<void> => {
    const v = name.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.stickers.create(workspaceId, { name: v });
      if (r.pack) {
        useStickers.getState().upsert(r.pack);
        setName('');
        onOpen(r.pack.id);
      }
    } catch (e) {
      if (!reportPlanError(e, workspaceId)) setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="text-caption text-muted">{t('stk.hint')}</p>
      <Card title={t('stk.newPack')}>
        <form
          className="flex items-center gap-2 px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            placeholder={t('stk.namePlaceholder')}
            aria-label={t('stk.name')}
            className="min-w-0 flex-1"
            data-testid="sticker-pack-name"
          />
          <Button type="submit" busy={busy} disabled={!name.trim()} data-testid="sticker-pack-create">
            <Plus className="size-4" aria-hidden /> {t('stk.create')}
          </Button>
        </form>
        {error ? (
          <p role="alert" className="px-3 pb-2.5 text-caption text-danger-text">
            {error}
          </p>
        ) : null}
      </Card>
      {loaded && packs.length === 0 ? (
        <Empty>{t('stk.noPacks')}</Empty>
      ) : (
        <Card title={t('stk.tab')}>
          {packs.map((p) => {
            const c = coverOf(p);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onOpen(p.id)}
                className="flex min-h-12 w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="sticker-pack-row"
              >
                {c ? <StickerImage sticker={c} size={36} /> : <span className="size-9 rounded-[var(--radius-card)] bg-[var(--color-fill)]" aria-hidden />}
                <span className="min-w-0 flex-1 truncate text-body font-medium">{p.name}</span>
                <span className="shrink-0 text-caption text-muted">{plural('stk.count', p.stickers.length, { n: p.stickers.length })}</span>
                <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
              </button>
            );
          })}
        </Card>
      )}
    </>
  );
}

/** A file waiting for its emoji before the batch upload. */
interface Staged {
  key: string;
  file: File;
  url: string;
  emoji: string;
}

const DEFAULT_EMOJI = '🙂';

function PackCard({ workspaceId, pack, onBack }: { workspaceId: string; pack: StickerPack; onBack: () => void }): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const cover = coverOf(pack)?.id;
  // Object URLs of staged previews are released with the list.
  useEffect(() => () => staged.forEach((s) => URL.revokeObjectURL(s.url)), [staged]);

  const apply = (p: StickerPack | undefined): void => {
    if (p) useStickers.getState().upsert(p);
  };
  const run = async (f: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await f();
    } catch (e) {
      if (!reportPlanError(e, workspaceId)) setError(err(e));
    }
  };
  const stage = (files: FileList | File[]): void => {
    const next: Staged[] = [];
    const problems: string[] = [];
    for (const f of Array.from(files)) {
      if (!looksLikeWebp(f.name, f.type)) problems.push(t('stk.notWebp', { name: f.name }));
      else if (f.size > STICKER_MAX_ANIMATED) problems.push(t('stk.tooBig', { name: f.name }));
      else next.push({ key: `${f.name}-${f.size}-${f.lastModified}-${Math.random()}`, file: f, url: URL.createObjectURL(f), emoji: DEFAULT_EMOJI });
    }
    setError(problems.length ? problems.join(' · ') : null);
    setStaged((cur) => [...cur, ...next].slice(0, STICKER_BATCH));
  };
  const upload = (): Promise<void> =>
    run(async () => {
      setProgress(0);
      try {
        const r = await uploadStickers(
          pack.id,
          staged.map((s) => ({ file: s.file, name: s.file.name, emoji: s.emoji })),
          setProgress,
        );
        apply(r.pack);
        setStaged([]);
      } finally {
        setProgress(null);
      }
    });
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) stage(e.dataTransfer.files);
  };
  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('stk.deletePackTitle', { name: pack.name }), t('stk.deletePackBody'), t('stk.deletePack')))) return;
    await run(async () => {
      await api.stickers.remove(pack.id);
      useStickers.getState().removePack(workspaceId, pack.id);
      onBack();
    });
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onBack} data-testid="sticker-back">
          <ChevronLeft className="size-4" aria-hidden /> {t('stk.tab')}
        </Button>
        <h3 className="min-w-0 truncate text-headline font-semibold" data-testid="sticker-pack-title">
          {pack.name}
        </h3>
        <span className="shrink-0 text-caption text-muted">{plural('stk.count', pack.stickers.length, { n: pack.stickers.length })}</span>
      </div>
      {error ? (
        <p role="alert" className="-mt-2 text-caption text-danger-text" data-testid="sticker-error">
          {error}
        </p>
      ) : null}
      <Card>
        <Row label={t('stk.name')}>
          <CommitInput value={pack.name} label={t('stk.name')} maxLength={64} onCommit={(v) => run(async () => apply((await api.stickers.update(pack.id, { name: v })).pack))} />
        </Row>
      </Card>

      <div
        className={cx(
          'flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-dashed px-4 py-5 text-center transition-colors duration-[var(--motion-fast)]',
          over ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]' : 'border-line',
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        data-testid="sticker-drop"
      >
        <Upload className="size-5 text-muted" aria-hidden />
        <p className="text-body text-fg">
          {t('stk.drop')} <span className="text-muted">{t('stk.dropOr')}</span>
        </p>
        <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
          {t('stk.pick')}
        </Button>
        <p className="text-caption text-muted">{t('stk.dropHint')}</p>
        <input
          ref={input}
          type="file"
          accept="image/webp,.webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) stage(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {staged.length ? (
        <Card title={plural('stk.count', staged.length, { n: staged.length })}>
          <ul className="grid grid-cols-4 gap-2 p-3 mobile:grid-cols-3" data-testid="sticker-staged">
            {staged.map((s) => (
              <li key={s.key} className="relative flex flex-col items-center gap-1">
                <img src={s.url} alt="" className="size-16 object-contain" draggable={false} />
                <EmojiField value={s.emoji} onChange={(v) => setStaged((cur) => cur.map((x) => (x.key === s.key ? { ...x, emoji: v } : x)))} />
                <IconButton
                  size="sm"
                  label={t('stk.unstage')}
                  className="absolute -right-1 -top-1"
                  onClick={() => setStaged((cur) => cur.filter((x) => x.key !== s.key))}
                >
                  <X className="size-3.5" aria-hidden />
                </IconButton>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-end gap-2 px-3 pb-3">
            {progress !== null ? <span className="text-caption text-muted">{t('stk.uploading', { pct: Math.round(progress * 100) })}</span> : null}
            <Button busy={progress !== null} disabled={staged.some((s) => !s.emoji.trim())} onClick={() => void upload()} data-testid="sticker-upload">
              <Upload className="size-4" aria-hidden /> {t('stk.upload')}
            </Button>
          </div>
        </Card>
      ) : null}

      {pack.stickers.length ? (
        <Card title={t('stk.tabStickers')}>
          <ul className="grid grid-cols-5 gap-2 p-3 mobile:grid-cols-3" data-testid="sticker-pack-stickers">
            {pack.stickers.map((s) => (
              <StickerCell
                key={s.id}
                sticker={s}
                cover={s.id === cover}
                onEmoji={(v) => run(async () => apply((await api.stickers.setEmoji(s.id, v)).pack))}
                onCover={() => run(async () => apply((await api.stickers.update(pack.id, { coverStickerId: s.id })).pack))}
                onDelete={() => run(async () => apply((await api.stickers.removeSticker(s.id)).pack))}
              />
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="flex justify-end">
        <Button variant="destructive" onClick={() => void remove()} data-testid="sticker-pack-delete">
          <Trash2 className="size-4" aria-hidden /> {t('stk.deletePack')}
        </Button>
      </div>
    </>
  );
}

function StickerCell({
  sticker,
  cover,
  onEmoji,
  onCover,
  onDelete,
}: {
  sticker: Sticker;
  cover: boolean;
  onEmoji: (v: string) => Promise<void>;
  onCover: () => Promise<void>;
  onDelete: () => Promise<void>;
}): ReactNode {
  return (
    <li className="group relative flex flex-col items-center gap-1 rounded-[var(--radius-card)] p-1 hover:bg-hover focus-within:bg-hover">
      <StickerImage sticker={sticker} size={64} />
      <EmojiField value={sticker.emoji} onCommit={(v) => void onEmoji(v)} />
      {cover ? (
        <span className="absolute left-1 top-1 grid size-5 place-items-center rounded-full bg-accent-strong text-accent-fg" title={t('stk.cover')}>
          <Star className="size-3" aria-label={t('stk.cover')} />
        </span>
      ) : null}
      <div className="absolute right-0 top-0 flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 mobile:opacity-100">
        {!cover ? (
          <IconButton size="sm" label={t('stk.makeCover')} onClick={() => void onCover()}>
            <Star className="size-3.5" aria-hidden />
          </IconButton>
        ) : null}
        <IconButton size="sm" label={t('stk.deleteSticker')} onClick={() => void onDelete()}>
          <Trash2 className="size-3.5" aria-hidden />
        </IconButton>
      </div>
    </li>
  );
}

/**
 * One emoji for a sticker: a narrow field (paste or the OS emoji picker); staged files change on
 * input, saved stickers commit on Enter / blur. Invalid (text) — the server says so.
 */
function EmojiField({ value, onChange, onCommit }: { value: string; onChange?: (v: string) => void; onCommit?: (v: string) => void }): ReactNode {
  const [v, setV] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setV(value);
  }
  const last = useMemo(() => lastGrapheme(v), [v]);
  return (
    <input
      value={v}
      onChange={(e) => {
        const g = lastGrapheme(e.target.value) || e.target.value;
        setV(g);
        onChange?.(g);
      }}
      onBlur={() => {
        if (onCommit && last && last !== value) onCommit(last);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape' && v !== value) {
          e.preventDefault();
          e.stopPropagation();
          setV(value);
        }
      }}
      aria-label={t('stk.emojiFor')}
      className="h-7 w-12 rounded-full bg-[var(--color-fill)] text-center text-[16px] focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
    />
  );
}

/** The last grapheme typed / pasted (an emoji may be several code points). */
function lastGrapheme(s: string): string {
  const seg = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  if (!seg) return s.slice(-2);
  const parts = Array.from(seg.segment(s), (x) => x.segment);
  return parts.at(-1) ?? '';
}
