# 10 — Бренд и домены

## Имя
Продукт называется **Calab**. Рабочее имя «Calaba» остаётся только во внутренних идентификаторах (npm-пакеты `@calaba/*`, Go-модуль, имена compose-контейнеров и volume, каталоги) — переименование их в пользовательском интерфейсе не видно и запланировано на после релиза (ADR при необходимости). Всё видимое пользователю — «Calab»: название приложения, окно, «О программе», лендинг, инсталляторы (`Calab-0.1.0-arm64.dmg`, `Calab Setup 0.1.0.exe`, `calab` для Linux), deep-link схема `calab://` (старая `calaba://` принимается как алиас), документы лицензии.

## Домены
| Хост | Что | Обслуживает |
|---|---|---|
| `calab.ru` | лендинг (Next.js static export, `apps/landing`) | Caddy `file_server` из `/srv/landing`; `/download/*` → те же релизы, что на app |
| `app.calab.ru` | приложение (веб-клиент, API, gateway, `/download/`) | Caddy → api :3000 + `/srv/web` |
| `rtc.calab.ru` | LiveKit signal | Caddy → :7880 |
| `turn.calab.ru` | TURN/TLS | Caddy layer4 → :5349 |
| `colaba.gptunnel.ai`, `colaba.gptunnel.ru` | алиасы приложения на переходный период (не лендинг) | как `app.` |

Конфиг Caddy: `DOMAIN=calab.ru`, `APP_HOST=app.calab.ru` (по умолчанию = DOMAIN), `LANDING_HOST=calab.ru` (пусто = без лендинга), `DOMAIN_ALT`/`DOMAIN_LEGACY` — дополнительные app-хосты. Сервер: `PUBLIC_APP_URLS` — список разрешённых origin через запятую (`PUBLIC_APP_URL`/`_ALT` остаются для совместимости). LiveKit `turn.domain = turn.${DOMAIN}`. DNS — Cloudflare, только DNS-only.

## Атрибуция
«Powered by GPTunneL» остаётся обязательной по лицензии (BSL 1.1, NOTICE) — на лендинге в футере, в «О программе», на экране входа.
