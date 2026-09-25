import type { ReactNode } from 'react';
import { create } from 'zustand';
import { t } from '../i18n';
import { Button, Modal } from './ui';

interface ConfirmState {
  req: { title: string; text: string; action: string; resolve: (ok: boolean) => void } | null;
}

const useConfirm = create<ConfirmState>()(() => ({ req: null }));

/** In-app confirmation (no native window.confirm). */
export function confirmAction(title: string, text: string, action: string): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ req: { title, text, action, resolve } }));
}

export function ConfirmHost(): ReactNode {
  const req = useConfirm((s) => s.req);
  const close = (ok: boolean): void => {
    req?.resolve(ok);
    useConfirm.setState({ req: null });
  };
  return (
    <Modal
      open={req !== null}
      onClose={() => close(false)}
      title={req?.title ?? ''}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={() => close(true)} autoFocus>
            {req?.action}
          </Button>
        </>
      }
    >
      <p className="text-muted">{req?.text}</p>
    </Modal>
  );
}
