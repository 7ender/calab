# ADR-0017: Valkey вместо Redis (2026-09-26)

## Контекст
Проект публикуется под BUSL-1.1, и лицензии всего, что мы поставляем и советуем разворачивать, должны быть простыми. Redis начиная с 7.4 распространяется под RSALv2/SSPLv1 (с 8.0 добавлен AGPLv3 как вариант): это source-available, а не OSI-лицензии, и они неудобны для дистрибуции и для самохостинга у пользователей. Серверу нужен Redis-совместимый сервер с per-field TTL для хешей (`HEXPIRE`, presence — docs/05), Lua, pub/sub, client-side caching (RESP3 tracking).

## Решение
- **Valkey ≥ 9.0** (BSD-3-Clause, форк Redis 7.2 под Linux Foundation) в `compose.yml` и `compose.dev.yml`, образ `valkey/valkey:9-alpine` с пином по digest. `HEXPIRE`/`HPEXPIRE` появились в Valkey 9.0.
- Клиент не меняется: `rueidis` работает с Valkey (протокол Redis), переменные `REDIS_URL` / `REDIS_PASSWORD` и ключ `redis` в `/readyz` остаются (это имя протокола, а не продукта).
- Проверка при старте (`redisx.checkVersion`): если в `INFO server` есть `valkey_version`, нужна ≥ 9.0 (Valkey для совместимости сообщает `redis_version:7.2.4`, по нему решать нельзя); иначе `redis_version` ≥ 7.4 — Redis по-прежнему работает для тех, кто его выбрал сам.
- Новый volume `valkey_data`: Valkey не читает RDB 12 от Redis 7.4 (`Can't handle RDB format version 12`, проверено). Там только временное состояние (маркеры отзыва, лимиты, voice, presence, буферы gateway), сессии живут в Postgres.

## Последствия
- При переходе на стенде данные старого `redis_data` не переносятся: активные сокеты переподключатся, presence/voice восстановятся за heartbeat/reconcile, лимиты обнулятся. Старый volume удаляется вручную после проверки.
- Интеграционные тесты идут против Valkey (dev-compose). CI-сервис стоит переключить на тот же образ.
- Если LiveKit когда-нибудь масштабируется через Redis — он тоже подключается к Valkey (совместим).
