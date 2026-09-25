import { createElectronPlatform } from './electron';
import type { Platform } from './types';
import { createWebPlatform } from './web';

/**
 * The host platform, fixed at build time: `vite build --mode web` sets VITE_PLATFORM=web
 * (apps/desktop/.env.web); the other branch is dead code and dropped from the bundle.
 */
export const platform: Platform = import.meta.env.VITE_PLATFORM === 'web' ? createWebPlatform() : createElectronPlatform();

export const isWeb = platform.kind === 'web';
export type { Platform };
