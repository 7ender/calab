// Public URLs shown on the landing. These are site content (not runtime config).
export const SITE_URL = 'https://calab.ru';
export const APP_URL = 'https://app.calab.ru';
// Stable installer names of the newest release (release.yml copies each stable release to latest/;
// latest/VERSION holds its number). Same names as the /download/<os> shortcuts in infra/docker/caddy.
export const LATEST_URL = 'https://releases.calab.ru/latest';
export const DOWNLOADS = {
  macArm64: `${LATEST_URL}/Calab-mac-arm64.dmg`,
  macX64: `${LATEST_URL}/Calab-mac-x64.dmg`,
  win: `${LATEST_URL}/Calab-win-x64.exe`,
  appImage: `${LATEST_URL}/Calab-linux-x86_64.AppImage`,
  deb: `${LATEST_URL}/calab-linux-amd64.deb`,
} as const;
// Single contact for licensing and support.
export const CONTACT_EMAIL = 'it@gptunnel.ai';
export const GPTUNNEL_URL = 'https://gptunnel.ai';
export const REPO_URL = 'https://github.com/itrcz/calab';
export const repoFile = (path: string): string => `${REPO_URL}/blob/main/${path}`;
