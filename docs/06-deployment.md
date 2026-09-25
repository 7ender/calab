# 06 — Деплой

## Сейчас: docker compose на одном хосте

Тестовый стенд: `root@141.105.69.177` (Debian 13, 32 vCPU, 123 GB RAM, 1.2 TB свободно, Docker 29, Compose v5).

**На хосте уже крутится GPU-задача** (`python` pid 3695 ~40 % RAM, `ffmpeg`, headless `chromium`, `Xvfb`; порты 8000/8001/8190/8210–8213/8300/8400/9100/9400, UDP 9001/9002). **Не трогаем.** Наши порты (80/443/7881/7882) с ними не пересекаются. RAM: ставим лимиты контейнерам (postgres 2G, api 1G, livekit 4G) чтобы не конкурировать; логи контейнеров ротируются.

Состав `infra/docker/compose.yml`:

| Сервис | Образ | Сеть | Заметки |
|---|---|---|---|
| caddy | своя сборка `infra/docker/caddy/Dockerfile` (`caddy:2.11.4` + `caddy-l4` v0.1.2, обе версии запинены) | host | 80/443 TCP, ACME, `Caddyfile`, layer4 как listener wrapper (SNI `turn.*`), h3 выключен |
| livekit | `livekit/livekit-server:v1.13` | host | signal 7880 (только 127.0.0.1), 7881/tcp, 7882/udp, TURN 443/udp, TURN 5349 (`external_tls`; слушает `*:5349` — LiveKit не умеет bind для TURN, снаружи закрыт файрволом), metrics 6789 (127.0.0.1) |
| api | `apps/server/Dockerfile` (Go → distroless static, nonroot) | **host**, `HTTP_ADDR=127.0.0.1:3000` | ходит в Postgres/Redis/LiveKit по 127.0.0.1; миграции сам при старте; файлы — `STORAGE_DRIVER=fs`, volume `files_data` → `/data/files` (ADR-0011) |
| postgres | `postgres:18-alpine` | bridge, `127.0.0.1:5432` | PG 18 — встроенный `uuidv7()`; volume на `/var/lib/postgresql` |
| redis | `redis:7-alpine` | bridge, `127.0.0.1:6379` | AOF; healthcheck `redis-cli ping` |
| files-init | `busybox:1.37` | — | одноразовый: `chown 65532:65532` на volume `files_data` (свежий named volume принадлежит root, а API в distroless работает как nonroot 65532); идемпотентен, api стартует после него (`service_completed_successfully`) |

Почему api в host network: API обращается к LiveKit (`127.0.0.1:7880`, signal слушает только loopback), а LiveKit шлёт webhook на `127.0.0.1:3000`. Из bridge-сети это требовало бы `host.docker.internal` и правил файрвола для `docker0`; в host network всё идёт по loopback, наружу API не торчит (слушает только 127.0.0.1).

MinIO нет (ADR-0011): образ `minio/minio` удалён с Docker Hub, сторонние сборки не берём; файлы API пишет драйвером `fs` в volume `calaba_files_data`. Драйвер `s3` (Garage / Ceph RGW / облако) — позже, для k8s.

Имя compose-проекта задано явно (`name: calaba`, dev — `calaba-dev`): контейнеры и volume называются `calaba-*`/`calaba_*`, `--remove-orphans` не заденет чужие проекты на общем хосте.

Логи всех сервисов — драйвер `json-file` с ротацией (`max-size: 50m`, `max-file: 5`), чтобы не забить диск общего стенда.

### Конфигурация и деплой

- Секреты — в `infra/docker/.env` на хосте (не в репо), шаблон — `.env.example`.
- LiveKit-конфиг — шаблон `infra/docker/livekit/livekit.yaml.tpl`. В нём подставляются **только** `${DOMAIN}` и `${LIVEKIT_API_KEY}` (`envsubst '${DOMAIN} ${LIVEKIT_API_KEY}'`) → `livekit.gen.yaml` (в `.gitignore`). Ключ/секрет LiveKit приходят через env `LIVEKIT_KEYS`, в файл не пишутся.
- `deploy.sh [сервисы…]` — загружает `.env`, рендерит `livekit.gen.yaml`, выполняет `docker compose up -d --build --remove-orphans [сервисы…]`. Если отрендеренный конфиг LiveKit изменился — перезапускает `livekit` (bind-mount: compose сам изменения содержимого не замечает). Caddyfile вшит в образ → подхватывается через `--build`.
- Деплой на стенд — с машины разработчика, **git на хосте нет**: `infra/docker/sync.sh [сервисы…]` = `rsync` рабочего дерева в `/opt/calaba` (без `node_modules`, `.git`, `dist`, `.env*`, `livekit.gen.yaml`; `--delete`, исключённые пути защищены) + `ssh … /opt/calaba/infra/docker/deploy.sh [сервисы…]`. `SYNC_ONLY=1` — только синхронизация; `STAND_HOST`/`STAND_DIR` переопределяют хост/каталог. CI (GitHub Actions) позже будет собирать образы.
- Миграции (`goose`) API выполняет **автоматически при старте** под `pg_advisory_lock` — при нескольких репликах мигрирует только одна, остальные ждут. Отдельного шага `migrate` при деплое нет (для k8s та же команда доступна как job).
- LiveKit работает одной нодой, Redis ему не нужен; блок `redis:` в шаблоне закомментирован — включить при добавлении второй ноды (db 1).

Подготовка хоста (одноразово):
```
# файрвол — только ДОБАВИТЬ ACCEPT в INPUT перед финальным DROP (никакого flush!), подробности — docs/03-network.md.
# На стенде: iptables(nf_tables), сохранение в /etc/iptables/rules.v4 (iptables-restore.service). Уже сделано:
tcp dport {80, 443, 7881} accept
udp dport {443, 7882} accept
# sysctl (на стенде уже 16 MB)
net.core.rmem_max=8388608  net.core.wmem_max=8388608
# пакеты
apt install gettext-base rsync   # envsubst для deploy.sh, rsync для sync.sh
mkdir -p /opt/calaba
```

### Стенд: как он поднят (2026-09-25)

- Код: `/opt/calaba` (копия рабочего дерева через `sync.sh`), секреты: `/opt/calaba/infra/docker/.env` (`chmod 600`, root; сгенерированы `openssl rand` по `.env.example`, `REGISTRATION_MODE=open`). `sync.sh` этот файл никогда не перезаписывает и не удаляет.
- Ключ/секрет LiveKit для тестов (`lk`, load-test) брать оттуда: `ssh root@141.105.69.177 'grep ^LIVEKIT_API_ /opt/calaba/infra/docker/.env'` — не коммитить и не вставлять в отчёты.
- `DOMAIN=141-105-69-177.sslip.io`. Сертификаты Let's Encrypt для `app.`/`rtc.`/`turn.` выпущены Caddy при первом старте (хранятся в volume `calaba_caddy_data`, при передеплое не перевыпускаются).
- Весь стек (с api) поднят 2026-09-25: `infra/docker/sync.sh` без аргументов; отдельный сервис — `infra/docker/sync.sh api`. Миграции применились при старте api.
- Регистрация открыта (`REGISTRATION_MODE=open`); тестовые аккаунты `owner@calaba.test` / `bob@calaba.test` (workspace `team`), пароль — `/opt/calaba/infra/docker/.env.accounts` (600; `sync.sh` не трогает `.env*`). Перед реальным использованием — `REGISTRATION_MODE=invite`.
- Снаружи через Caddy доступны только `app.*` (API; `/metrics` закрыт — `respond /metrics 404`, скрейпить `127.0.0.1:3000/metrics` на хосте), `rtc.*` (signal), `turn.*` (TURN/TLS).
- Проверки и ожидаемые выводы — `TESTING.md`, раздел «Стенд».

### Переход на свой домен

1. A-записи `app.<домен>`, `rtc.<домен>`, `turn.<домен>` → 141.105.69.177 (AAAA не заводить, пока нет IPv6 на хосте и правил для него). Дождаться, пока `dig +short turn.<домен>` вернёт IP.
2. На хосте в `/opt/calaba/infra/docker/.env`: `DOMAIN=<домен>`.
3. `infra/docker/sync.sh` (или на хосте `deploy.sh`): Caddy пересоберётся/перезапустится с новым `DOMAIN` из env и выпустит новые сертификаты; `livekit.gen.yaml` перерендерится (`turn.domain`) → LiveKit перезапустится сам; API получит новые `PUBLIC_APP_URL`/`LIVEKIT_URL`.
4. Клиентам — новый адрес сервера. Старые sslip-сертификаты в volume просто истекут, чистить не нужно.
5. Лимиты Let's Encrypt на `sslip.io` общие для всех. Если упрёмся: задать `email` в глобальном блоке Caddyfile — тогда Caddy при неудаче LE автоматически пробует ZeroSSL (без email фолбэк на ZeroSSL не работает); либо явно `acme_ca`/`issuer zerossl`.

Домен: A-записи `app`, `rtc`, `turn` → 141.105.69.177. Пока своего домена нет, стенд работает на `sslip.io`: `DOMAIN=141-105-69-177.sslip.io` (→ `app.141-105-69-177.sslip.io`, `rtc.…`, `turn.…`, DNS настраивать не нужно). Лимиты Let's Encrypt на `sslip.io` общие для всех — годится только для первых проб; для постоянной работы владельцу нужен свой домен.

## Dev локально (macOS)

`infra/docker/compose.dev.yml`: postgres, redis, livekit (dev-режим: `--dev`, ключи `devkey/secret`, без TLS, UDP mux 7882). API и Electron — на хосте через pnpm; файлы API в dev — `STORAGE_DRIVER=fs` с локальным каталогом (`infra/docker/data/` в `.gitignore`). LiveKit в Docker на macOS не имеет host-сети → для локальных тестов медиа между двумя машинами в LAN LiveKit лучше запускать бинарником (`brew install livekit`), в Docker — только для одного клиента на localhost.

## Потом: Kubernetes

Путь без переписывания:
1. Уже сейчас: всё через env, API stateless, health-эндпоинты `/healthz` `/readyz`, миграции при старте под `pg_advisory_lock` (безопасно для нескольких реплик).
2. k3s на одной ноде → Helm-чарты: свой `calaba-api`, официальный `livekit-server` (`hostNetwork`, Redis), `cloudnative-pg`, файлы — PVC (RWO, один API) или драйвер `s3` (Garage / внешний S3) при нескольких репликах, Traefik с `IngressRouteTCP HostSNI(turn.*)` passthrough.
3. Добавление нод: LiveKit масштабируется через Redis (комната закрепляется за нодой), API — обычными репликами, gateway — pub/sub уже через Redis.

Не использовать: private/serverless кластеры (NAT ломает WebRTC), LB перед 7881.

## Наблюдаемость

- LiveKit: `/metrics` Prometheus на `127.0.0.1:6789` (`prometheus.port` в шаблоне; `bind_addresses: 127.0.0.1` действует и на него, снаружи порт ещё и закрыт файрволом). Проверка с хоста: `curl -s 127.0.0.1:6789/metrics | grep -c '^livekit_'` (сейчас ~60 метрик). **Скрейп пока не настроен.** Prometheus на самом хосте нет: `prometheus-node-exporter` (:9100) скрейпит внешний Prometheus из подсетей Yandex Cloud (`84.201.128.0/18`, `51.250.0.0/17`, `178.154.192.0/18` — разрешены в iptables только для 9100/9400). Варианты подключения, по возрастанию изменений:
  1. Отдать метрики через Caddy: `rtc.<domain>` → `handle /metrics` → `reverse_proxy 127.0.0.1:6789` с `basic_auth` (или `remote_ip` этих подсетей); у внешнего Prometheus job `scheme: https`, `metrics_path: /metrics`, target `rtc.<domain>`. Файрвол и конфиг LiveKit не трогаем — предпочтительно.
  2. Отдельный порт: `prometheus.port` на публичном интерфейсе нельзя без смены `bind_addresses` (он же signal) → не делать.
  Дашборд — официальный LiveKit Grafana dashboard.
- API: `slog` JSON-логи, `/metrics` (client_golang): активные сокеты, события/с, латентность REST и fan-out. Только с хоста (`127.0.0.1:3000/metrics`); на `app.*` Caddy отвечает 404. Подключать к внешнему Prometheus тем же способом, что и LiveKit (отдельный путь в Caddy с `basic_auth`).
- Клиент: crash-репорты (Sentry self-hosted — позже), локальный лог в `userData/logs`.

## Резервные копии

- Postgres: `pg_dump` ежедневно, хранить 14 дней.
- **`pg_dump` на том же хосте — не бэкап**: при потере диска/хоста теряются и данные, и копии. Нужна внешняя площадка (другой хост / внешний S3) — **offsite target: TODO владелец**.
- Файлы (volume `calaba_files_data`, на хосте `/var/lib/docker/volumes/calaba_files_data/_data`): `restic`/`rsync` на ту же внешнюю площадку — после выбора offsite target.
