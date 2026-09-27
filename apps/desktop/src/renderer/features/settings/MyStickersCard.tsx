import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Card, IconButton } from '../../components/ui';
import { plural, t } from '../../i18n';
import { coverOf } from '../../lib/stickers';
import { loadMyStickers, orderPacks, uninstallPack } from '../../services/stickers';
import { useStickers } from '../../stores/stickers';
import { StickerImage } from '../chat/stickers/StickerImage';

/**
 * «Профиль → Мои стикеры» (ADR-0030): my packs in the order of the sticker panel — move up /
 * down, remove. Packs are added from the panel or from a sticker in the chat.
 */
export function MyStickersCard(): ReactNode {
  const installed = useStickers((s) => s.installed);
  const loaded = useStickers((s) => s.loaded);
  useEffect(() => {
    void loadMyStickers(true);
  }, []);
  const move = (i: number, d: -1 | 1): void => {
    const ids = installed.map((p) => p.id);
    const j = i + d;
    const a = ids[i];
    const b = ids[j];
    if (a === undefined || b === undefined) return;
    ids[i] = b;
    ids[j] = a;
    void orderPacks(ids);
  };
  return (
    <Card title={t('stk.mine')}>
      {loaded && installed.length === 0 ? <p className="px-3 py-2.5 text-body text-muted">{t('stk.mineEmpty')}</p> : null}
      {installed.map((p, i) => {
        const c = coverOf(p);
        return (
          <div key={p.id} className="flex min-h-11 items-center gap-3 px-3 py-1" data-testid="my-sticker-pack">
            {c ? <StickerImage sticker={c} size={32} /> : <span className="size-8" aria-hidden />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-medium">{p.name}</p>
              <p className="text-caption text-muted">{plural('stk.count', p.stickers.length, { n: p.stickers.length })}</p>
            </div>
            <IconButton size="sm" label={t('stk.moveUp')} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp className="size-4" aria-hidden />
            </IconButton>
            <IconButton size="sm" label={t('stk.moveDown')} disabled={i === installed.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown className="size-4" aria-hidden />
            </IconButton>
            <IconButton size="sm" label={t('stk.removePack')} onClick={() => void uninstallPack(p.id)}>
              <X className="size-4" aria-hidden />
            </IconButton>
          </div>
        );
      })}
      {installed.length ? <p className="px-3 pb-2.5 pt-1 text-caption text-muted">{t('stk.mineHint')}</p> : null}
    </Card>
  );
}
