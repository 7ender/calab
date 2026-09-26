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

Sources are the shared 2x (Retina) macOS window captures in `docs/images/` (also used by the root README):
`chat`, `stream`, `settings`, `onboarding` as `<name>-{dark,light}@2x.png` (2880×1800, window 1440×900 pt,
`screencapture -l` without shadow) and `chat-{dark,light}-shadow@2x.png` for the hero.

1. Replace the PNGs in `docs/images/` (keep names; PNG > 3 MB → `oxipng` / `pngquant --quality 90-100`).
2. `pnpm -F @calaba/landing assets` — `scripts/assets.mjs` writes `public/screens/<name>-<theme>@2x.webp` at full
   resolution (no downscale, WebP q92) plus a 1x Lanczos resample `<name>-<theme>.webp`; feature cards are crops
   (660×400 pt → 1320×800 px) whose offsets are in window points at the top of the script — check them when the
   app layout changes. The 1200×630 `public/og.png` is composed from the 2x chat capture.
3. Pages use `srcset` 1x/2x with `width`/`height` in CSS pixels. Rebuild and commit `public/`.

## TODO

- Telegram channel in the footer when there is one (contact now: `it@gptunnel.ai`).
- FAQ hardware estimate («ориентировочно 4 vCPU и 8 ГБ» for up to 30 users) comes from the compose memory limits,
  not a load test — refine after the load test.
