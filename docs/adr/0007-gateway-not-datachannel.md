# ADR-0007: Чат и presence через свой WS gateway (2026-09-25)

## Решение
Собственный WebSocket gateway (Discord-стиль: HELLO/IDENTIFY/RESUME, seq, heartbeat, Redis-буфер для resume). LiveKit data channels — только для эфемерных сигналов внутри звонка.

## Почему
Data channels LiveKit не буферизуются на сервере, best-effort, ограничены 15 KiB, живут только внутри room и обрываются вместе с медиа. Чат должен работать и вне voice, с историей и офлайн-доставкой.

## Последствия
Два соединения у клиента (WSS gateway + WebRTC). Gateway stateless, fan-out через Redis pub/sub — готово к k8s.
