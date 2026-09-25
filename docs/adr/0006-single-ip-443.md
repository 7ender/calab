# ADR-0006: Один IP, всё через 443 (2026-09-25)

> Способ терминации TURN/TLS и сборка Caddy уточнены в [ADR-0010](0010-turn-tls-in-caddy.md): TLS для `turn.*` терминирует Caddy, LiveKit работает с `external_tls`.

## Решение
Caddy (`livekit/caddyl4`) слушает 443/TCP: SNI `turn.*` → passthrough на LiveKit TURN/TLS 5349; остальное — HTTPS terminate → API / LiveKit signal. TURN/UDP на 443/UDP (HTTP/3 выключен). ICE/TCP 7881, UDP mux 7882. Встроенный TURN LiveKit вместо coturn.

## Почему
Порядок фолбэка UDP → TCP → TURN/UDP → TURN/TLS покрывает VPN и файрволы «только 443». Embedded TURN не требует отдельной аутентификации и релеит по localhost. coturn нужен только при втором IP.

## Последствия
- Нужны домены `app`, `rtc`, `turn` с валидными сертификатами.
- LiveKit в host network → правила nftables на хосте обязательны.
- В k8s — TLS-passthrough в Traefik/ingress-nginx по тому же принципу.
