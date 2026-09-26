# @calaba/landing — calab.ru

Marketing landing for **Calab**. Next.js 15 (`output: 'export'`) + Tailwind v4, Russian UI, no server:
the build is plain static files in `out/`.

## Commands

```sh
pnpm -F @calaba/landing dev        # http://localhost:3000
pnpm -F @calaba/landing build      # → apps/landing/out (index.html, 404.html, robots.txt, sitemap.xml, manifest)
pnpm -F @calaba/landing lint
pnpm -F @calaba/landing typecheck
pnpm -F @calaba/landing assets     # regenerate public/screens/*.webp and public/og.png
```

Preview the export: `npx -y serve apps/landing/out` (or `python3 -m http.server -d apps/landing/out`).

## Where it is served

`https://calab.ru` — Caddy `file_server` from `/srv/landing` (see `docs/10-branding.md`, `LANDING_HOST`).
Copy the contents of `out/` there. `trailingSlash: true`, so any future page `/x/` is exported as `x/index.html`.
Links: «Открыть в браузере» → `https://app.calab.ru`, downloads → `https://app.calab.ru/download/` (directory
listing, never versioned file names), licence and support → `it@gptunnel.ai` (`CONTACT_EMAIL`), source → `https://github.com/itrcz/calab` (`REPO_URL` in `src/lib/site.ts`; LICENSE/SECURITY/TRADEMARKS links point to `blob/main/…`).

## Design

Follows `docs/08-design.md`: system font stack, one accent (`#0A84FF`/`#007AFF`, white-on-accent fills use
`#0071e3`), 4 px grid, glass only on the sticky header (solid with `prefers-reduced-transparency`), light/dark
via `prefers-color-scheme` only, motion only under `prefers-reduced-motion: no-preference`. Tokens live in
`src/app/globals.css`. All components are server components; the FAQ uses native `<details>`, so the page works
without JS (the Next runtime chunk still ships, ~100 kB).

## Updating screenshots

Images come from the desktop visual-regression snapshots
(`apps/desktop/e2e-visual/__screenshots__/darwin/*-{dark,light}-1440.png`, 1440×800 @1x):

1. Update the snapshots in `apps/desktop` (its visual tests).
2. `pnpm -F @calaba/landing assets` — `scripts/assets.mjs` copies the hero (`main-chat`) and crops four
   660×400 feature images (`onboarding-mode`, `voice-room-settings-2`, `chat-context-menu`, `room-settings-3`)
   into `public/screens/<name>-{dark,light}.webp`, and composes the 1200×630 `public/og.png`.
   If the app layout moved, adjust the crop rectangles in the script and check the result.
3. Rebuild and commit `public/`.

## TODO

- Telegram channel in the footer when there is one (contact now: `it@gptunnel.ai`).
- FAQ hardware estimate («ориентировочно 4 vCPU и 8 ГБ» for up to 30 users) comes from the compose memory limits,
  not a load test — refine after the load test.
