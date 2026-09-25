# ADR-0010: TURN/TLS терминируется в Caddy (2026-09-25) — уточняет ADR-0006

## Контекст
ADR-0006 предполагал SNI-passthrough `turn.*` на LiveKit TURN/TLS :5349, где LiveKit сам терминирует TLS сертификатом, который Caddy кладёт в общий volume. Это связывает контейнеры через внутренний путь хранилища Caddy (меняется при смене ACME CA), требует перезапуска LiveKit при продлении сертификата и даёт TLS-фингерпринт Go-сервера LiveKit вместо обычного веб-сервера. Готовый образ `livekit/caddyl4` — сторонний и непинуемый.

## Решение
- Caddy собираем сами (`infra/docker/caddy/Dockerfile`: `xcaddy` + `github.com/mholt/caddy-l4`, версия запинена) и конфигурируем `Caddyfile`.
- layer4 работает как `listener_wrapper` HTTP-сервера `:443`: SNI `turn.<domain>` → `tls` (терминация в Caddy) → `proxy 127.0.0.1:5349`; остальной трафик идёт в обычный HTTPS-сервер (`app.*`, `rtc.*`). Сайт `turn.<domain>` (`respond 404`) существует только ради автоматического сертификата.
- LiveKit: `turn.external_tls: true`, `tls_port: 5349`, без `cert_file/key_file`, без общего volume с Caddy.
- HTTP/3 выключен (`protocols h1 h2`) — UDP 443 остаётся за TURN/UDP.

## Последствия
- Сертификаты целиком на Caddy: продление без участия LiveKit.
- TLS-фингерпринт TURN совпадает с HTTPS-сайтами сервера (см. docs/03, раздел про цензуру).
- Обновление caddy-l4 — осознанный bump версии в Dockerfile (плагин предупреждает о breaking changes).
