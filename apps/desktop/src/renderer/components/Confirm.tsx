import type { ReactNode } from 'react';
import { create } from 'zustand';
import { t } from '../i18n';
import { Button, Modal } from './ui';

interface ConfirmState {
  req: { title: string; text: string; action: string; tone: 'destructive' | 'primary'; resolve: (ok: boolean) => void } | null;
}

const useConfirm = create<ConfirmState>()(() => ({ req: null }));

/** In-app confirmation (no native window.confirm). `tone: 'primary'` for non-destructive actions. */
export function confirmAction(title: string, text: string, action: string, tone: 'destructive' | 'primary' = 'destructive'): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirm.getState().req?.resolve(false); // a newer request replaces an open one
    useConfirm.setState({ req: { title, text, action, tone, resolve } });
  });
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
      closeButton={false}
      footer={
        <>
          {/* Primary-tone prompts guard external triggers (deep links): Enter must not accept. */}
          <Button variant="secondary" onClick={() => close(false)} autoFocus={req?.tone === 'primary'}>
            {t('common.cancel')}
          </Button>
          <Button variant={req?.tone === 'primary' ? 'primary' : 'destructive'} onClick={() => close(true)} autoFocus={req?.tone !== 'primary'}>
            {req?.action}
          </Button>
        </>
      }
    >
      <p className="text-muted">{req?.text}</p>
    </Modal>
  );
}
