# ADR-0015: Веб-клиент из того же renderer (2026-09-25)

## Контекст
Владелец хочет входить не только через десктоп-клиент, но и через браузер по адресу `https://app.<domain>`. Renderer — React + `livekit-client`, оба работают в браузере; API и gateway уже живут на `app.<domain>` (тот же origin → без CORS).

## Решение
- В `apps/desktop/src/renderer` вводится слой **`platform`** с двумя реализациями: `electron` (IPC/preload) и `web` (браузерные API). Интерфейс: `auth storage` (Electron — safeStorage через main; web — refresh в httpOnly `Secure; SameSite=Strict` cookie, access-токен в памяти), `api transport` (Electron — через main; web — `fetch` same-origin с cookie), `ptt` (Electron — глобальный uiohook; web — только при фокусе, `keydown/keyup` на document), `screen picker` (Electron — свой; web — `getDisplayMedia` браузера), `notifications`, `windows` (popout — `window.open`), `downloads`.
- Сборка `vite build --mode web` → `apps/desktop/dist-web`; Caddy на `app.*`: `handle /api/* /gateway /healthz /readyz → reverse_proxy 127.0.0.1:3000`, остальное — `file_server` SPA (`try_files … /index.html`) из volume, куда статику кладёт `sync.sh`/CI. Заголовки: CSP (`default-src 'self'; connect-src 'self' wss://rtc.<domain>; media-src blob:`), `X-Frame-Options: DENY`.
- Сервер: cookie-режим refresh (`POST /api/auth/refresh` читает cookie, если нет тела; выставляет cookie при login/register с `Origin`-проверкой), CSRF — `SameSite=Strict` + проверка `Origin` на мутациях.
- Поддерживаемые браузеры: Chromium-based (Chrome/Edge/Yandex) и Firefox; Safari — best effort (AV1-декод и AEC отличаются).

## Последствия
- Один код UI для трёх ОС и веба; платформенные различия изолированы в `platform`.
- Веб не умеет глобальный PTT и системный звук стрима; кодек стрима в Firefox/Safari может откатиться на VP9/H.264 — SFU это допускает.
- CSP и cookie-auth добавляют тестовые сценарии в TESTING.md.
