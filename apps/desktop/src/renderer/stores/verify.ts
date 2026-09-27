import { create } from 'zustand';

/**
 * «Подтвердите почту» bar (ADR-0023): a blocked action (403 EMAIL_NOT_VERIFIED) bumps
 * `attention`; the bar then takes the focus and shows why the action needs the code.
 */
interface VerifyState {
  attention: number;
  request: () => void;
}

export const useVerify = create<VerifyState>()((set) => ({
  attention: 0,
  request: () => set((s) => ({ attention: s.attention + 1 })),
}));
