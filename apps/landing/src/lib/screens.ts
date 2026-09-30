// Screenshot sizes in CSS px (= the crops of scripts/assets.mjs; the @2x file is twice as large).
// Files: public/screens/<lang>/<name>.webp and <name>@2x.webp, the app and its team in that language.
export const SCREENS = {
  voice: { width: 1440, height: 900 },
  chat: { width: 1110, height: 870 },
  call: { width: 1440, height: 870 },
  calendar: { width: 1110, height: 870 },
  findtime: { width: 1110, height: 870 },
  kanban: { width: 1110, height: 600 },
  timeline: { width: 1110, height: 870 },
  task: { width: 510, height: 870 },
  notes: { width: 1370, height: 560 },
  guest: { width: 600, height: 460 },
} as const;

export type ScreenName = keyof typeof SCREENS;
