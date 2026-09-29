# @calaba/landing — calab.ru

Marketing landing for **Calab**. Next.js 15 (`output: 'export'`) + Tailwind v4, no server: the build is plain static
files in `out/`. Localized (ADR-0022 §3): `ru` (source), `en`, `es`, `zh-CN`.

## Commands

```sh
pnpm -F @calaba/landing dev        # http://localhost:3000
pnpm -F @calaba/landing build      # → apps/landing/out (index.html, ru/ en/ es/ zh/, 404.html, robots.txt, sitemap.xml, manifest)
pnpm -F @calaba/landing lint
pnpm -F @calaba/landing typecheck
pnpm -F @calaba/landing assets     # regenerate public/screens/*.webp and public/og.png
```

Preview the export: `npx -y serve apps/landing/out` (or `python3 -m http.server -d apps/landing/out`).

## Localization

- Routes: `/ru/`, `/en/`, `/es/`, `/zh/` and `/<locale>/bots/` (Bot API page, ADR-0031; docs link: ru → `docs/19-bot-api.md`, others → `.en.md`) — pages per locale (`src/app/[locale]/`, `generateStaticParams`,
  `dynamicParams = false`), `<html lang>`, title/description/OG, canonical and `hreflang` (+ `x-default → /en/`) per locale.
- `/` is `out/index.html` from `src/app/index.html/route.ts`: a content-less redirect page (no React runtime). Order:
  the switcher's saved choice (`localStorage['calab.locale']`) → `navigator.languages` (first supported: ru/uk/be/kk →
  `ru`, zh* → `zh`, es* → `es`, en* → `en`) → `/en/`. Query and `#hash` are kept, so old `calab.ru/#download` links
  (release notes, `/download/` fallback in Caddy) land on `/<locale>/#download`. Without JS: `<noscript>` meta refresh
  to `/en/`. In `next dev` it is served at `/index.html`, not `/`.
- Texts: `src/i18n/<locale>.ts`, typed by `ru.ts` (`Dict`): a missing or extra key fails `typecheck`. `{name}`
  placeholders become links/`<code>` via `rich()` (`src/lib/rich.tsx`) — keep them in every locale. Terms follow
  `docs/i18n-glossary.md` (workspace/espacio/工作区, room/sala/房间, screen share/pantalla compartida/屏幕共享 …);
  «Powered by GPTunneL» and product/tech names are never translated. es/zh are agent translations, native review pending.
- Language switcher: header pill (`locale-switcher.tsx`, native `<details>` + links, works without JS); names in their own
  language (Русский · English · Español · 中文); with JS it saves the choice and keeps the current `#section`.
- `404.html` is shared by all locales (English + links to each language). Caddy redirects unknown locale prefixes
  (`/de/`, `/pt-BR/…`) to `/en/` and `/ru` → `/ru/`.
- Screenshots follow the page: `ThemedImage` takes the locale and loads `<name>-<locale>-<theme>` (the app UI in that
  language; mock people, rooms and messages stay Russian). `og.png` is Russian for every locale.

## Where it is served

`https://calab.ru` — Caddy `file_server` from `/srv/landing` (see `docs/10-branding.md`, `LANDING_HOST`).
Copy the contents of `out/` there. `trailingSlash: true`, so every page `/x/` is exported as `x/index.html`.
Links: «Открыть в браузере» → `https://app.calab.ru`, downloads → direct links to the stable names
`https://releases.calab.ru/latest/<file>` (`DOWNLOADS` in `src/lib/site.ts`; the main button picks the visitor's OS
in the browser, the version comes from `latest/VERSION`, never versioned file names), licence and support → `it@gptunnel.ai` (`CONTACT_EMAIL`), source → `https://github.com/itrcz/calab` (`REPO_URL` in `src/lib/site.ts`; LICENSE/SECURITY/TRADEMARKS links point to `blob/main/…`).

## Design

Follows `docs/08-design.md`: system font stack, one accent (`#0A84FF`/`#007AFF`, white-on-accent fills use
`#0071e3`), 4 px grid, solid materials only (no `backdrop-filter`, the sticky header too), light/dark
via `prefers-color-scheme` only, motion only under `prefers-reduced-motion: no-preference`. Tokens live in
`src/app/globals.css`. All components are server components except `download-primary.tsx` (OS detection + `latest/VERSION`); the FAQ uses native `<details>`, so the page works
without JS (the Next runtime chunk still ships, ~100 kB).

## Updating screenshots

Every screenshot is captured in each UI language (docs/09 #110). The scene is set up once in Russian (the test's
selectors), then the app switches language live (visual-test hook `__calabaLocale`) and each locale is captured.

1. Captures — `apps/desktop/e2e-marketing/landing.spec.ts`, the mock-driven renderer (`out/`, no packaged app) at
   1440 pt wide, 2x on a Retina Mac; dev LiveKit running (`pnpm infra:dev`), one Playwright/Electron run at a time:
   ```sh
   pnpm -F @calaba/desktop build:app && pnpm -F @calaba/desktop build:web   # web: the phone shot
   cd apps/desktop
   CALABA_VISUAL_MOCK_PORT=39370 MOCK_LIVEKIT_ROOM_PREFIX=landing_ pnpm exec playwright test --config playwright.marketing.config.ts -g landing
   CALABA_LANDING_THEME=light CALABA_VISUAL_MOCK_PORT=39370 MOCK_LIVEKIT_ROOM_PREFIX=landing_ pnpm exec playwright test --config playwright.marketing.config.ts -g landing
   ```
   `CALABA_LANDING_LOCALES=ru,en` narrows the languages, `-g "landing chat"` one scene. Raw full-window PNGs land in
   `apps/landing/shots/<shot>-<locale>-<theme>@2x.png` (git-ignored, ~0.3 MB each). Scenes: `hero` (in voice, badges),
   `voice` (+ noise popover), `stream`, `camera` (blur, workspace backgrounds), `chat` (forwarded + sticker strip),
   `call` (1:1 call), `recording` (card playing), `badges` (README only, ru), `mobile` (iPhone 14 in WebKit).
2. `pnpm -F @calaba/landing assets` — `scripts/assets.mjs` crops (offsets in window points at the top of the script —
   check them when the app layout changes; the CSS sizes in `hero.tsx`/`features.tsx` equal the crops), draws the
   traffic lights on the hero, writes `public/screens/<name>-<locale>-<theme>@2x.webp` at full resolution plus a 1x
   Lanczos resample, each ≤ 250 KB (quality steps down from 90 until it fits); a locale without captures gets the
   English files. Also `docs/images/readme/*.webp` (README: ru, dark, whole window, ≤ 400 KB) and `public/og.png`
   (from the ru dark hero: commit it only when the OG art should change).
3. Pages use `srcset` (width descriptors + `sizes`) with `width`/`height` in CSS pixels (no layout shift); the hero
   and the first two feature rows load eagerly. Rebuild and commit `public/screens` and `docs/images/readme`.

## TODO

- Telegram channel in the footer when there is one (contact now: `it@gptunnel.ai`).
- FAQ hardware estimate («ориентировочно 4 vCPU и 8 ГБ» for up to 30 users) comes from the compose memory limits,
  not a load test — refine after the load test.
