# ADR-0002: LiveKit self-hosted как SFU (2026-09-25)

## Контекст
Нужен SFU с simulcast/SVC, адаптивной подпиской, TURN, масштабированием на k8s, хорошим JS SDK. Кандидаты: LiveKit, mediasoup, Janus.

## Решение
LiveKit server v1.13.x (OSS, Go), `livekit-client` 2.22.x, `livekit-server-sdk` на сервере.

## Почему
- В OSS: simulcast, VP9/AV1 SVC, dynacast, adaptive stream, Opus DTX/RED, встроенный TURN (UDP/TLS), UDP mux, ICE/TCP, Redis multi-node, Helm-чарт.
- mediasoup — библиотека, а не сервер: сигналинг, TURN, масштабирование писать самим. Janus — слабее клиентская адаптация.
- Cloud-only только Krisp — заменяем RNNoise на клиенте.

## Последствия
- Зависим от релизов LiveKit; пинним minor-версию, обновляем осознанно.
- Одна LiveKit room = одна voice-комната; права дублируются в grant токена.
- Voice-state строится из webhooks, нужен reconcile.
