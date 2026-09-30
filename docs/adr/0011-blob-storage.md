# ADR-0011: Файлы — локальный диск через абстракцию `blob.Store`, S3 позже (2026-09-25)

## Контекст
Планировался MinIO. На момент деплоя образ `minio/minio` удалён с Docker Hub, `quay.io/minio` закрыт; доступны только сторонние сборки (`pgsty/minio`) — supply-chain риск. Для MVP на одном хосте (≤30 пользователей, квота 10 GB на workspace) отдельный S3-сервис не даёт ничего, кроме лишнего процесса и точки отказа.

## Решение
- В Go — интерфейс `internal/blob.Store` (`Put(ctx, key, r, size, contentType)`, `Get(ctx, key) (ReadSeekCloser, meta)`, `Delete`, `Stat`).
- Драйвер **`fs`** (по умолчанию): `STORAGE_DRIVER=fs`, `STORAGE_PATH=/data/files`; ключи вида `<workspace_id>/<file_id>[.thumb]`; запись через temp-файл + rename (атомарно); docker volume `files_data`.
- Драйвер **`s3`** (`STORAGE_DRIVER=s3`, AWS SDK v2, path-style): для Kubernetes/масштабирования; целевые бэкенды — Garage / Ceph RGW / облачный S3. Реализуется на этапе 5, проверяется в CI против Garage.
- MinIO из compose удалён. Колонка `files.bucket` не нужна — только `key`.

## Последствия
- Бэкап файлов = бэкап volume (`rsync`/`restic` offsite — TODO владелец).
- Переезд на k8s с одним инстансом API — PVC (RWO); с несколькими — переключение на `s3` без изменения кода вызывающих.

## Реализация драйвера `s3` (2026-09-28)
Этап 5 выполнен в рамках решения выше, решение не меняется. `internal/blob/s3.go`: AWS SDK v2 (`service/s3`, multipart — `feature/s3/manager`), path-style по умолчанию, статический ключ; `Open` принимает `blob.Config`. Переменные — `STORAGE_S3_*`: имена `S3_*` уже заняты бакетом публичных релизов. Контракт `Store` у `fs` и `s3` проверяется одним набором тестов (unit — `fs` и `s3` поверх fake, integration — `s3` против Garage в CI). Квоты считаются по Postgres и от драйвера не зависят. Эксплуатация — docs/06 «Файлы в S3: драйвер `s3`».
