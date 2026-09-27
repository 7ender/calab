import { WorkspaceRole, type Sticker } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Modal, Spinner } from '../../../components/ui';
import { plural, t } from '../../../i18n';
import { api } from '../../../lib/api/endpoints';
import { installPack, loadMyStickers, uninstallPack } from '../../../services/stickers';
import { useStickers } from '../../../stores/stickers';
import { useWorkspaces } from '../../../stores/workspaces';
import { StickerImage } from './StickerImage';

/**
 * The pack of a sticker in the feed (Telegram): its stickers and «Добавить пак» / «Убрать из
 * моих» (ADR-0030). Guests of the pack's workspace only look; a deleted pack says so.
 */
export function StickerPackDialog({ sticker, onClose }: { sticker: Sticker; onClose: () => void }): ReactNode {
  const q = useQuery({ queryKey: ['sticker-pack', sticker.packId], queryFn: () => api.stickers.get(sticker.packId), retry: false, staleTime: 30_000 });
  const pack = q.data?.pack;
  const installed = useStickers((s) => s.installed.some((p) => p.id === sticker.packId));
  const loaded = useStickers((s) => s.loaded);
  const role = useWorkspaces((s) => (pack ? s.byId[pack.workspaceId]?.role : undefined));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!loaded) void loadMyStickers();
  }, [loaded]);
  const canInstall = role !== undefined && role !== WorkspaceRole.GUEST;
  const act = async (): Promise<void> => {
    if (!pack) return;
    setBusy(true);
    try {
      if (installed) await uninstallPack(pack.id);
      else if (await installPack(pack)) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={pack?.name ?? t('stk.tabStickers')}
      description={pack ? plural('stk.count', pack.stickers.length, { n: pack.stickers.length }) : undefined}
      footer={
        pack && canInstall ? (
          <Button variant={installed ? 'secondary' : 'primary'} busy={busy} onClick={() => void act()} data-testid="sticker-pack-action">
            {installed ? t('stk.removePack') : t('stk.addPack')}
          </Button>
        ) : undefined
      }
    >
      {q.isPending ? (
        <div className="grid h-40 place-items-center">
          <Spinner />
        </div>
      ) : !pack ? (
        <p className="py-6 text-center text-body text-muted">{t('stk.packGone')}</p>
      ) : (
        <div className="grid grid-cols-5 gap-1" data-testid="sticker-pack-grid">
          {pack.stickers.map((s) => (
            <div key={s.id} className="grid h-[72px] place-items-center">
              <StickerImage sticker={s} size={64} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
