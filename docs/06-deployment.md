# 06 — Деплой

## Сейчас: docker compose на одном хосте

Тестовый стенд: `root@141.105.69.177` (Debian 13, 32 vCPU, 123 GB RAM, 1.2 TB свободно, Docker 29, Compose v5).

**На хосте уже крутится GPU-задача** (`python` pid 3695 ~40 % RAM, `ffmpeg`, headless `chromium`, `Xvfb`; порты 8000/8001/8190/8210–8213/8300/8400/9100/9400, UDP 9001/9002). **Не трогаем.** Наши порты (80/443/7881/7882) с ними не пересекаются. RAM: ставим лимиты контейнерам (postgres 2G, api 1G, livekit 4G) чтобы не конкурировать; логи контейнеров ротируются.

Состав `infra/docker/compose.yml`:

| Сервис | Образ | Сеть | Заметки |
|---|---|---|---|
| caddy | своя сборка `infra/docker/caddy/Dockerfile` (`caddy:2.11.4` + `caddy-l4` v0.1.2, обе версии запинены; `entrypoint.sh` собирает списки хостов из `DOMAIN`/`DOMAIN_ALT`/`DOMAIN_LEGACY`) | host | 80/443 TCP, ACME, `Caddyfile`, layer4 как listener wrapper (SNI `turn.*`), h3 выключен |
| livekit | `livekit/livekit-server:v1.13` | host | signal 7880 (только 127.0.0.1), 7881/tcp, 7882/udp, TURN 443/udp, TURN 5349 (`external_tls`; слушает `*:5349` — LiveKit не умеет bind для TURN, снаружи закрыт файрволом), metrics 6789 (127.0.0.1) |
| api | `apps/server/Dockerfile` (Go → distroless static, nonroot) | **host**, `HTTP_ADDR=127.0.0.1:3000` | ходит в Postgres/Valkey/LiveKit по 127.0.0.1; миграции сам при старте; файлы — `STORAGE_DRIVER=fs`, volume `files_data` → `/data/files` (ADR-0011; каталог создан в образе с владельцем nonroot 65532, свежий named volume наследует его — отдельный chown не нужен); healthcheck — `/server healthcheck` |
| postgres | `postgres:18-alpine` | bridge, `127.0.0.1:5432` | PG 18 — встроенный `uuidv7()`; volume на `/var/lib/postgresql` |
| valkey | `valkey/valkey:9-alpine` — Valkey, совместим с Redis (ADR-0017) | bridge, `127.0.0.1:6379` | AOF, volume `valkey_data`; healthcheck `valkey-cli ping` |
| egress | `livekit/egress:v1.14.1` (digest запинен; совместим с livekit-server 1.13) | host | запись встреч (ADR-0025): audio-only room composite без Chrome → MP4 в volume `recordings_data` (`/out`); с LiveKit — через Valkey (DB 1) и ws `127.0.0.1:7880`; лимит 4 CPU / 4 GB; внутренний порт шаблонов 7980 (снаружи закрыт файрволом) |
| recordings-init | образ valkey (one-shot) | none | делает `recordings_data` владением api (65532) до старта api/egress |

Почему api в host network: API обращается к LiveKit (`127.0.0.1:7880`, signal слушает только loopback), а LiveKit шлёт webhook на `127.0.0.1:3000`. Из bridge-сети это требовало бы `host.docker.internal` и правил файрвола для `docker0`; в host network всё идёт по loopback, наружу API не торчит (слушает только 127.0.0.1).

MinIO нет (ADR-0011): образ `minio/minio` удалён с Docker Hub, сторонние сборки не берём; файлы API пишет драйвером `fs` в volume `calaba_files_data`. Драйвер `s3` (Garage / Ceph RGW / облако) — позже, для k8s.

Имя compose-проекта задано явно (`name: calaba`, dev — `calaba-dev`): контейнеры и volume называются `calaba-*`/`calaba_*`, `--remove-orphans` не заденет чужие проекты на общем хосте.

Логи всех сервисов — драйвер `json-file` с ротацией (`max-size: 50m`, `max-file: 5`), чтобы не забить диск общего стенда.

### Конфигурация и деплой

- Секреты — в `infra/docker/.env` на хосте (не в репо), шаблон — `.env.example`.
- LiveKit-конфиг — шаблон `infra/docker/livekit/livekit.yaml.tpl`. В нём подставляются **только** `${DOMAIN}` и `${LIVEKIT_API_KEY}` (`envsubst '${DOMAIN} ${LIVEKIT_API_KEY}'`) → `livekit.gen.yaml` (в `.gitignore`). Ключ/секрет LiveKit приходят через env `LIVEKIT_KEYS`, в файл не пишутся.
- `deploy.sh [сервисы…]` — загружает `.env`, рендерит `livekit.gen.yaml`, выполняет `docker compose up -d --build --remove-orphans [сервисы…]`. Если отрендеренный конфиг LiveKit изменился — перезапускает `livekit` (bind-mount: compose сам изменения содержимого не замечает). Caddyfile вшит в образ → подхватывается через `--build`.
- **`SYNC_REF=<ref>`** — деплоить закоммиченное состояние (чистый `git archive`), а не рабочее дерево; обязательно, когда в дереве чужая незакоммиченная работа (иначе она уедет на стенд). Артефакты веба/релизов (не в git) берутся из рабочего дерева. Пример: `SYNC_REF=HEAD SKIP_WEB=1 SKIP_RELEASES=1 infra/docker/sync.sh api`.
- **Версия сборки** для `GET /api/version`: `sync.sh` передаёт `CALABA_COMMIT` (короткий sha `SYNC_REF`, либо `HEAD`, с суффиксом `-dirty`, если синхронизируется грязное дерево в `apps/server`/`infra`/`proto`/`packages`) и `CALABA_VERSION` (`VERSION=` или `apps/desktop/package.json`) → `deploy.sh` → build args образа api.
- Деплой на стенд — с машины разработчика, **git на хосте нет**: `infra/docker/sync.sh [сервисы…]` = `rsync` рабочего дерева в `/opt/calaba` (без `node_modules`, `.git`, `dist`, `.env*`, `livekit.gen.yaml`; `--delete`, исключённые пути защищены) + `ssh … /opt/calaba/infra/docker/deploy.sh [сервисы…]`. `SYNC_ONLY=1` — только синхронизация; `STAND_HOST`/`STAND_DIR` переопределяют хост/каталог. CI (GitHub Actions) позже будет собирать образы.
- Миграции (`goose`) API выполняет **автоматически при старте** под `pg_advisory_lock` — при нескольких репликах мигрирует только одна, остальные ждут. Отдельного шага `migrate` при деплое нет (для k8s та же команда доступна как job).
- Детектор говорящих LiveKit (секция `audio` шаблона: `active_level: 40`, `update_interval: 150`, см. docs/02 «Индикация речи собеседников») читается только при старте: изменение вступает в силу после перезапуска `livekit` — `deploy.sh` делает это сам при изменении отрендеренного конфига (короткий обрыв медиа, выкатывать в релизное окно).
- LiveKit работает одной нодой, но с Redis (Valkey, DB 1, пароль — env `REDIS_PASSWORD` контейнера, в файл не рендерится): без него egress недоступен (ADR-0025). **Первый деплой с записью встреч перезапускает LiveKit** (изменился отрендеренный конфиг) — короткий обрыв звонков, выкатывать в релизное окно; порядок: `deploy.sh valkey livekit egress api`.
- **Запись встреч (ADR-0025).** env api: `GPTUNNEL_API_URL` (по умолчанию `https://gptunnel.ru`), `GPTUNNEL_WEB_URL` (`https://gptunnel.ru`: ссылки GPTunneL на `app.gptunnel.ai` показываются на нём, docs/17), `RECORDING_KEEP_DAYS` (30: столько дней аудио готовой записи висит вложением карточки, считается в квоту пространства как вложения), `RECORDING_MAX_CONCURRENT` (3; одна запись ≈ 0.5 CPU egress), `RECORDINGS_PATH=/data/recordings` + `RECORDING_EGRESS_DIR=/out` (один volume `recordings_data` в двух контейнерах). Диск: AAC ~128 кбит/с ≈ 60 МБ/ч, ≤ 4 ч на запись → ≤ ~250 МБ; после `done` файл переезжает в хранилище вложений (S3/fs) и удаляется с volume, из хранилища — через `RECORDING_KEEP_DAYS`; неудачные — с volume через 7 дней; volume в бэкапы не входит (записи временные). Проверка на стенде — smoke из TESTING «Запись встреч». Подключение пространства — код из GPTunneL в настройках пространства.
- **Боты (ADR-0031).** env api: `BOT_RATE_PER_SEC` (30 запросов в секунду на бота), `BOT_MESSAGES_PER_MIN` (20 сообщений в минуту на бота); лимит ботов на пространство — ключ `bots` в `PLAN_FREE_LIMITS` / `PLAN_TEAM_LIMITS` (по умолчанию 2 / 20). Webhook-и ботов уходят с api-контейнера наружу по https (только публичные адреса), нужен исходящий доступ в интернет.

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
- **Домены (docs/10-branding.md):** целевая схема — `DOMAIN=calab.ru` (`rtc.calab.ru`, `turn.calab.ru`; TURN анонсируется по нему), `APP_HOST=app.calab.ru` (веб-клиент, API, gateway, `/download/`), `LANDING_HOST=calab.ru` (статика `apps/landing/out` → `/opt/calaba/landing`, bind `../../landing:/srv/landing:ro`; там же `/download/` — те же релизы), `DOMAIN_ALT=app.calab.ru` и `DOMAIN_LEGACY=meet.gptunnel.ru` — дополнительные хосты приложения (их `rtc.`/`turn.` тоже обслуживаются на переходный период). `entrypoint.sh` Caddy собирает из этого списки хостов и генерирует сайт лендинга (`/tmp/landing.caddy`, пустой при `LANDING_HOST=`); `PUBLIC_APP_URL=https://${APP_HOST}`, `PUBLIC_APP_URL_ALT=https://${DOMAIN_ALT}` (до серверного `PUBLIC_APP_URLS` origin `DOMAIN_LEGACY` не проходит CSRF/Origin-проверку веб-клиента — десктоп не затронут).
  - **Состояние 2026-09-26:** стенд на `calab.ru` (делегирование `.ru` ~08:22): `.env` — `DOMAIN=calab.ru`, `APP_HOST=app.calab.ru`, `LANDING_HOST=calab.ru`, `DOMAIN_ALT=meet.gptunnel.ru`, `DOMAIN_LEGACY=` (пусто), `RELEASES_HOST=releases.calab.ru`, `S3_PUBLIC_URL=https://storage.yandexcloud.net/calaba` (бакет `calaba`, Yandex Object Storage, публичное чтение). Сертификаты LE: `calab.ru`, `app.`, `rtc.`, `turn.`, `releases.calab.ru`, `meet.gptunnel.ru`; LiveKit анонсирует `turn.calab.ru`; `PUBLIC_APP_URLS=https://app.calab.ru,https://meet.gptunnel.ru` (чужой Origin — 403); `/download/…` на приложении и лендинге → 302 на `releases.calab.ru` (прокси в бакет). Лендинг опубликован (`apps/landing`, b9467d1). Алиасы `colaba.gptunnel.ai/.ru` и их `rtc.`/`turn.` сняты (DNS-записи удалены, Caddy их не обслуживает; старые сертификаты просто истекут).
  - Лендинг: не SPA — `/foo` → `foo.html` или `foo/index.html` (static export с `trailingSlash`), неизвестный путь → `404.html` со статусом 404; `/_next/static/*` — `immutable` только если файл есть, страницы — `no-cache`; CSP лендинга допускает inline-скрипты (`script-src 'self' 'unsafe-inline'` — гидрация Next.js static export без сервера для nonce), без connect-целей кроме self; HSTS, `X-Frame-Options DENY`, `Permissions-Policy` без камеры/микрофона. `sync.sh`: `LANDING_DIST` (по умолчанию `apps/landing/out`), `SKIP_LANDING=1`; без сборки — заглушка.
- История: до переименования (2026-09-25…26) стенд жил на `colaba.gptunnel.ai` (основной) + `colaba.gptunnel.ru`; сертификаты Let's Encrypt на все имена выпускает Caddy (volume `calaba_caddy_data`).
- DNS — Cloudflare (зоны `gptunnel.ai`, `gptunnel.ru`), A-записи `colaba` (приложение), `rtc.colaba`, `turn.colaba` → 141.105.69.177, **proxied=false** (DNS-only), TTL auto. Токен Cloudflare — только у владельца/в локальном `.env` репо (`CFTOKEN`, gitignored), на сервер не копируется.
- Весь стек (с api) поднят 2026-09-25: `infra/docker/sync.sh` без аргументов; отдельный сервис — `infra/docker/sync.sh api`. Миграции применились при старте api.
- Регистрация **только по приглашению** (`REGISTRATION_MODE=invite`, с 2026-09-26 — security review H2); бессрочный инвайт владельца в workspace `team` (10 использований) — в `/opt/calaba/infra/docker/.env.accounts` (строка `invite`). Тестовые аккаунты `owner@calaba.test` / `bob@calaba.test` (workspace `team`), пароль — `/opt/calaba/infra/docker/.env.accounts` (600; `sync.sh` не трогает `.env*`). 
- Снаружи через Caddy доступны только `<домен>` (API + веб-клиент; `/metrics` и `/readyz` закрыты — 404, изнутри `127.0.0.1:3000/metrics`, `127.0.0.1:3000/readyz`; снаружи для мониторинга — `/healthz`), `rtc.*` (signal), `turn.*` (TURN/TLS).

### Защита стенда (security review 2026-09-26)

- Контейнеры api/caddy/postgres/valkey: `read_only: true` + tmpfs `/tmp`, `cap_drop: [ALL]`, `no-new-privileges`. Caddy — только `NET_BIND_SERVICE` (80/443); postgres и valkey запускаются сразу своими пользователями (`70:70`, `999:1000`) — без gosu и без capabilities; api — distroless nonroot 65532. LiveKit пока без этого (host network, TURN на 443/udp) — TODO.
- Лимиты памяти: api 1G, caddy 512m, postgres 2G, valkey 768m (`maxmemory 512mb`), livekit 4G.
- Valkey: пароль (`REDIS_PASSWORD` в `.env`, в `REDIS_URL` api), пароль передаётся через конфиг в tmpfs, а не в argv (не виден в `ps` на общем хосте); `maxmemory-policy noeviction` — сессии/отзывы/буферы gateway нельзя терять молча (при нехватке — ошибки записи, видно в логах).
- Переезд стенда Redis 7.4 → Valkey 9.1 — 2026-09-26: бэкап, `docker stop calaba-redis-1` (порт 127.0.0.1:6379 должен освободиться до старта valkey), `SYNC_REF=HEAD infra/docker/sync.sh valkey api` (`--remove-orphans` удалил контейнер redis), новый volume `calaba_valkey_data` (Valkey не читает RDB 12 Redis 7.4 — там только временное состояние: отзывы токенов, лимиты, presence, буферы gateway; клиенты переподключаются, сессии в Postgres сохраняются). Проверено: `NOAUTH` без пароля, `noeviction`/512mb, `HEXPIRE`/`HTTL` работают, пароль не виден в `ps`, вход/gateway/голос/webhook — OK; после проверки удалены `calaba_redis_data` и образ `redis:7.4-alpine`.
- Диск: `STORAGE_MAX_TOTAL_BYTES` = 50 GiB на все загрузки (плюс квоты пространств и лимит пространств на пользователя — на стороне api).
- Заголовки: HSTS `max-age=31536000; includeSubDomains` на `<домен>` и `rtc.<домен>` (без preload — зоны `gptunnel.*` не наши); на `/api/*` — `Referrer-Policy: same-origin` (Caddy), `Cache-Control: no-store` и `nosniff` ставит сам api.
- Образы запинены по digest (compose, Dockerfile Caddy и api, CI); обновления — Dependabot (`.github/dependabot.yml`: actions, gomod, npm, docker, docker-compose), в CI — `govulncheck`, Actions по SHA, golangci-lint запинен.
- Файрвол: TURN-relay ограничен (docs/03 «TURN relay»), IPv6 INPUT — политика DROP (`/etc/iptables/rules.v6`, `ip6tables-restore.service`).

### Веб-клиент на `<домен>` (ADR-0015)

- Маршруты Caddy на каждом `<домен>` (приложение живёт на самом домене, без префикса `app.`): `/metrics` → 404; `/api/*`, `/gateway`, `/healthz`, `/readyz` → `reverse_proxy 127.0.0.1:3000`; остальное — SPA-статика из `/srv/web` (`file_server`, `try_files {path} /index.html`).
- Статика: на хосте `/opt/calaba/web` (bind mount `../../web:/srv/web:ro` в caddy). `sync.sh`: если локально есть `apps/desktop/dist-web/index.html` — `rsync --delete-after --delay-updates` в `/opt/calaba/web` (новые ассеты появляются раньше нового `index.html`, старые удаляются после); иначе при пустом каталоге кладёт заглушку `infra/docker/web-placeholder/index.html` («Calaba web — скоро»). Основной `rsync` репо каталог `/web/` не трогает. Caddy при обновлении статики не перезапускается.
- Кэш: `/assets/*` (хэшированные файлы Vite) — `public, max-age=31536000, immutable` только если файл существует (отсутствующий ассет — 404 без долгого кэша, не `index.html`); всё остальное (`index.html`, SPA-маршруты) — `no-cache`.
- Заголовки на статике: `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' wss://rtc.<каждый домен> https://rtc.<каждый домен>; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` (`'wasm-unsafe-eval'` — RNNoise WASM в mic-worklet; список rtc-origin-ов собирает `entrypoint.sh` из всех доменов — клиент на `.ru` ходит в `rtc.<DOMAIN>`, т.к. API отдаёт основной `LIVEKIT_URL`; `https://rtc.*` — для `/rtc/validate` livekit-client), `Permissions-Policy: microphone=(self), display-capture=(self), speaker-selection=(self), autoplay=(self)` (Chrome пишет в консоль безвредное предупреждение `Unrecognized feature: 'speaker-selection'` — фича есть только в Firefox), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, без `Server`. CSP подтверждена клиентом; прогон 2026-09-25 в Chromium и Firefox — нарушений нет.
- Сжатие: `encode zstd gzip` только на статике (ответы API, в т.ч. файлы с Range, не трогаются). JS ~1.3 MB → ~0.4 MB; mic-worklet (RNNoise WASM внутри) ~1.9 MB → ~1.7 MB.
- `sync.sh` не публикует `*.map`.
- API разрешает браузерные origin-ы из `PUBLIC_APP_URLS` (список через запятую) плюс `PUBLIC_APP_URL` и `PUBLIC_APP_URL_ALT` (cookie-refresh, CSRF-проверка, upgrade gateway). `DOMAIN_LEGACY` в этот список **не входит** — веб-клиент по legacy-именам работать не будет (десктоп — будет).
- Манифест PWA: `*.webmanifest` отдаётся как `application/manifest+json` (в MIME-таблице Go его нет — Caddy ставит заголовок явно), `*.svg` — `image/svg+xml`.
- Публикация статики без перезапуска: `infra/docker/sync.sh` (если `apps/desktop/dist-web` есть локально). Флаг `SKIP_WEB=1` — не трогать опубликованную статику (например, пока сборка не готова).

### Релизы десктопа: `/download/` (фид electron-updater)

- `https://<домен>/download/` → статика из `/opt/calaba/releases` (bind mount `../../releases:/srv/releases:ro` в caddy), листинг каталога (`file_server browse`) включён только здесь; `/download` → 308 на `/download/`. Это же — фид electron-updater (generic provider, `url: https://app.calab.ru/download/`).
- Кэш: `latest*.yml`, `*.yaml`, `*.json` и листинги — `no-cache` (меняются на месте); установщики и `*.blockmap` (версия в имени) — `public, max-age=31536000, immutable`. Типы: `*.yml` — `text/yaml`, `*.dmg/*.AppImage/*.deb/*.exe/*.blockmap` — `application/octet-stream` (в MIME-таблице Go их нет), `*.zip` — `application/zip`. Range (206) работает — докачка и differential-обновления. Сжатие здесь выключено.
- Публикация: `sync.sh` — если локально есть `apps/desktop/dist-release/`, копирует `*.dmg *.zip *.AppImage *.deb *.exe *.blockmap latest*.yml *.json` в `/opt/calaba/releases` **без `--delete`** (старые версии остаются доступными) и с `--delay-updates` (`latest*.yml` появляется вместе с установщиками, updater не увидит ссылку на ещё не залитый файл). `SKIP_RELEASES=1` — пропустить. Основной `rsync` репо каталог `/releases/` не трогает. Удалять старые версии — вручную на хосте.
- Имена файлов с версией обязательны (immutable-кэш): перезалить тот же файл с тем же именем нельзя — только новая версия.
- Проверки и ожидаемые выводы — `TESTING.md`, раздел «Стенд».

### Релизы десктопа: сборка

Все три ОС собираются с одного Mac (Apple Silicon): `apps/desktop/scripts/build-release.sh [mac] [linux] [win]` (без аргументов — все). На Apple Silicon Linux/Windows собираются на x86_64-хосте: `BUILD_DOCKER_HOST=ssh://root@141.105.69.177` (стенд, согласовано; без эмуляции, в разы быстрее и не забивает диск мака образом 4.7 GB).

- **Источник** — чистый `git archive` коммита `SRC_REF` (по умолчанию `HEAD`) во временном каталоге (`WORK_DIR`, по умолчанию `$TMPDIR/calaba-release`): незакоммиченные правки в релиз не попадают, рабочее дерево и `node_modules` разработчика не трогаются. Требование: коммит должен ставиться `pnpm install --frozen-lockfile` (lockfile в синхроне с `package.json`). Версия — из `apps/desktop/package.json`; `VERSION=1.2.3` переопределяет её только в экспорте (`npm version --no-git-tag-version`).
- **Нативный `uiohook-napi`** — только наша пропатченная сборка (`patches/uiohook-napi@1.5.5.patch`): `electron-builder.yml` исключает upstream-prebuilds и включает `buildDependenciesFromSource`. Скрипт проверяет, что патч применён, и **валит сборку, если в пакете нет `.node`** (`ptt.ts` импортирует модуль статически — без него main падает при старте).
- **macOS** — нативно, `electron-builder --mac`: отдельные **arm64 и x64** (dmg + zip; так задано в `electron-builder.yml`, фид отдаёт подходящий). Модуль компилируется из исходников под каждую арх (x64 — кросс-компиляцией на Apple Silicon); скрипт проверяет `lipo -archs` каждого `Calaba.app` (arm64 / x86_64). Требуется Xcode Command Line Tools.
- **Linux (AppImage + deb, x64)** — в Docker `electronuserland/builder:wine` (Ubuntu 22.04, Node 24; запинен по digest): исходники копируются в контейнер (без `node_modules`), `pnpm install --frozen-lockfile --ignore-scripts`, `electron-vite build`, установка X11-заголовков, `electron-builder --linux` с `npmRebuild` — `uiohook` компилируется под Electron в контейнере. Затем **smoke** в том же контейнере: AppImage распаковывается (squashfs по смещению из ELF), приложение стартует под Xvfb, проверка — процесс жив через 20 с и есть X-окно «Calaba» (`xwininfo`); `SMOKE=0` — пропустить.
- **Удалённый хост** (`BUILD_DOCKER_HOST`, для Windows-только — `WIN_DOCKER_HOST`): исходники, скрипт контейнера и env-файл уходят `rsync` в `/tmp/calaba-release-<pid>-<platform>`, контейнер запускается одной ssh-сессией (`docker run -i … bash -s < script`; `DOCKER_HOST=ssh://` открывает много сессий и упирается в `MaxStartups` sshd) с `--cpus 4 --memory 6g --cpu-shares 128 --blkio-weight 10` (`REMOTE_CPUS`/`REMOTE_MEMORY`), артефакты возвращаются, каталог удаляется; ssh/rsync — с повторами. Кэши — docker volumes `calaba-release-pnpm-store`, `calaba-release-electron-cache` на хосте сборки; образ остаётся для повторов.
- **Windows (NSIS, x64)** — только на x86_64-хосте (`BUILD_DOCKER_HOST`): на Apple Silicon NSIS под wine невозможен (стаб 32-битный, Rosetta в Docker — только x86_64, qemu-i386 падает). Нативный модуль: node-gyp не умеет собирать win32 вне Windows, поэтому **для Windows (решение 2026-09-26, вариант b) в пакет возвращается upstream N-API prebuild `prebuilds/win32-x64`** — наш патч меняет только darwin-код libuiohook (+ константа, используемая там же), на Windows модуль идентичен. Задано в `electron-builder.yml` как `win.files` FileSet (`[{from: ., filter: [prebuilds, prebuilds/win32-x64/**]}]`) — для node_modules electron-builder берёт из строковых `files` только исключения, включение возможно лишь FileSet-ом; для коммитов без этой настройки скрипт генерирует то же в `electron-builder.win.yml` (`extends: ./electron-builder.yml`) внутри копии исходников. Для macOS/Linux политика «только пропатченная сборка из исходников» не меняется. Проверка скрипта «в пакете есть `.node`» остаётся (в инсталляторе ровно `app.asar.unpacked/node_modules/uiohook-napi/prebuilds/win32-x64/uiohook-napi.node`).
- **CI: `.github/workflows/release.yml`** (репозиторий `github.com/itrcz/calab`, `RELEASE_REPO`; фид по умолчанию `https://app.calab.ru/download/`) — по тегу `v*` или вручную (`workflow_dispatch`, `version`, `publish_stand`): матрица macos-latest (arm64 + x64), ubuntu-22.04, windows-latest — везде нативно, поэтому пропатченный модуль компилируется из исходников и на Windows (MSVC раннера), без override. Артефакты → GitHub Release (`gh release create`, для ручного запуска — draft) и, если заданы секреты `STAND_SSH_KEY`/`STAND_HOST`/`STAND_KNOWN_HOSTS` (отдельный deploy-пользователь с правом записи только в `/opt/calaba/releases`, host key запинен), — `rsync --delay-updates` без `--delete` на `/download/`. Там же — место для подписи (stage 4). Actions запинены по SHA.
- **Результат** — `apps/desktop/dist-release/` (в `.gitignore`): `Calab-<ver>-arm64.dmg/.zip`, `Calab-<ver>-x64.dmg/.zip`, `Calab-<ver>-x86_64.AppImage`, `calab_<ver>_amd64.deb`, `Calab-Setup-<ver>-x64.exe` (продукт — Calab, docs/10; внутренние имена `calaba-*` остаются), `*.blockmap`, `latest-mac.yml`, `latest-linux.yml`, `latest.yml`. Имена без пробелов и с версией (`/download/` кэширует установщики как immutable). В `app-update.yml`/`latest*.yml` — generic-фид `UPDATE_URL` (по умолчанию `https://app.calab.ru/download/`).
- **Публикация** — `SKIP_WEB=1 infra/docker/sync.sh` (копирует `dist-release` в `/opt/calaba/releases`, без удаления старых версий). Перед публикацией поднять версию (`VERSION=`): electron-updater обновляет только на бо́льшую.
- **Замеры (2026-09-26, коммит 63524d5, v0.0.1):** macOS arm64+x64 — 48 с (прогретый кэш Electron); dmg 125/129 MB, zip 125/128 MB. Linux на стенде — 2 мин 15 с (с компиляцией uiohook и smoke); AppImage 122 MB, deb 97 MB. Windows на стенде — 55 с (с upstream prebuild win32-x64); NSIS 109 MB, не подписан. Нагрузка стенда во время сборок: load average 3.3 → 3.9–4.7 из 32 CPU, GPU-задача не затронута.

**Подписи нет** (сборки для тестов):
- macOS: `identity: null` → Gatekeeper: «приложение от неустановленного разработчика» — открыть через ПКМ → «Открыть» (или `xattr -dr com.apple.quarantine /Applications/Calaba.app`). Автообновление на macOS **без подписи не работает** (Squirrel.Mac проверяет подпись) — клиент только сообщает о новой версии. Нужно от владельца: **Apple Developer Program** (99 $/год) → сертификат *Developer ID Application* (.p12 → `CSC_LINK`, `CSC_KEY_PASSWORD`) и нотаризация (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` или App Store Connect API key); в `electron-builder.yml` убрать `identity: null`, включить `notarize`. Hardened runtime и entitlements уже настроены.
- Windows: без подписи SmartScreen «Windows защитила ваш компьютер» → «Подробнее» → «Выполнить в любом случае»; репутация копится только у подписанных сборок. Нужно: сертификат подписи кода (OV/EV; с 2023 ключ только на токене/HSM — практичнее облачная подпись: Azure Trusted Signing, SSL.com eSigner, DigiCert KeyLocker) → `win.azureSignOptions`/`signtoolOptions` в `electron-builder.yml`, секреты в env. Облачную подпись удобно делать в том же Windows-раннере CI.
- Linux: подпись не нужна (AppImage/deb без подписи — норма; при желании GPG-подпись .deb/репозитория).

### Релизы: GitHub Actions → S3 → releases.calab.ru

Основной путь выпуска (решение владельца 2026-09-26): сборка в GitHub Actions на нативных раннерах, хранение в S3-совместимом бакете, фид автообновления `https://releases.calab.ru/`. `build-release.sh`/`release.sh` с Mac остаются запасным путём и для проверок стенда.

**Выпуск:** `git tag v0.1.0 && git push origin v0.1.0` → `.github/workflows/release.yml`:
1. `build` — матрица macos-latest (arm64 + x64), ubuntu-22.04 (AppImage + deb), windows-latest (NSIS); пропатченный `uiohook` компилируется из исходников везде; проверка «в пакете есть `.node`».
2. `github-release` — GitHub Release `v0.1.0` со всеми файлами (`gh release create`, репозиторий `itrcz/calab`).
3. `publish-s3` — в бакет: `releases/<version>/` ← установщики и `*.blockmap` (`Cache-Control: public, max-age=31536000, immutable`); затем **последними** в корень — `latest-mac.yml`, `latest-linux.yml`, `latest.yml` (их `url:`/`path:` переписаны на `releases/<version>/…`, `sha512` не меняется) и `index.html` со ссылками (`no-cache`). Клиент никогда не увидит фид, ссылающийся на ещё не залитый файл. Затем (только стабильные версии, без `-rc…`) — **`latest/`**: server-side copy (`aws s3 cp s3://…/releases/<ver>/… s3://…/latest/…`, без повторной загрузки) под стабильными именами `Calab-mac-arm64.dmg`, `Calab-mac-x64.dmg`, `Calab-win-x64.exe`, `Calab-linux-x86_64.AppImage`, `calab-linux-amd64.deb` (`no-cache`, `Content-Disposition` с версионным именем) и последним `latest/VERSION` с номером. Фиды `latest*.yml` это не трогает.
4. `publish-stand` — запасной: только если S3-секретов нет — `rsync` на стенд в `/opt/calaba/releases` (плоско, как раньше). Если нет ни тех, ни других — сборка есть в GitHub Release, публикации нет (warning).
Ручной запуск (`workflow_dispatch`): `version`, `publish` (по умолчанию нет); Release создаётся черновиком.

**Подпись — только с валидным материалом.** Шаг `signing setup` декодирует base64 и проверяет: `.p12` открывается своим паролем (`openssl pkcs12 -passin`, с `-legacy`-фолбэком), `.p8` — валидный приватный ключ (`openssl pkey`). Отсутствует / заглушка / неверный пароль → сборка **без подписи** с notice, не падение (проверено на 6 сценариях: заглушка, валидный + нотаризация, валидный без .p8, неверный пароль, Windows валидный/неверный).
- macOS: `APPLE_CERT_P12_BASE64` + `APPLE_CERT_PASSWORD` → CI удаляет `identity: null` из `electron-builder.yml` в своей копии и подписывает (Developer ID Application: SCRIPTHEADS, TOO, Team `3KGZ3829US`); `APPLE_TEAM_ID` передаётся в окружение (notarytool); нотаризация (`-c.mac.notarize=true`) — только если валидны `APPLE_API_KEY_BASE64` + `APPLE_API_KEY_ID` + **`APPLE_API_ISSUER`** (Issuer ID пока нет → подпись без нотаризации, warning; Gatekeeper на других машинах такую сборку всё равно не пропустит без «Открыть» — нужна нотаризация).
- Локальная проверка подписи: `SIGN=1 MAC_ARCH=arm64 SRC_REF=WORKTREE build-release.sh mac` — берёт identity из login keychain (или `cert/developerID_full.p12` + `APPLE_CERT_PASSWORD` из `.env`), без нотаризации и по умолчанию без secure timestamp (`SIGN_TIMESTAMP=1` — с ним; из-за локального VPN сервер меток времени Apple периодически не отвечает на сотни запросов подряд, а один промах валит codesign). Временный keychain electron-builder (путь `CSC_LINK`) на свежей macOS не работает (`security set-key-partition-list … SecKeychainUnlock`), поэтому локально — identity из login keychain.
- Windows: `WIN_CERT_P12_BASE64` + `WIN_CERT_PASSWORD` → signtool на windows-раннере.
Материал передаётся в electron-builder файлами из `RUNNER_TEMP` через `GITHUB_ENV` (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY*`).

**Фид `releases.calab.ru` (Caddy):** хост `RELEASES_HOST` (по умолчанию `releases.<DOMAIN>`; пусто — выключен). Если задан `S3_PUBLIC_URL` — публичный базовый URL бакета (Yandex Object Storage path-style `https://storage.yandexcloud.net/<bucket>` или virtual-hosted без пути) — `reverse_proxy` в него (`Host` апстрима, префикс пути из URL), `/` → `index.html` (при заданном `LANDING_HOST` — редирект на лендинг, см. ниже); `*.yml` и `index.html` — `no-cache`, остальное — `immutable` (заголовки ставит Caddy поверх ответа S3). Без S3 — раздаёт `/srv/releases` (то же, что `/download/`). При заданном `RELEASES_HOST` `/download/*` на приложении и лендинге — **302 на тот же путь** хоста релизов: старые клиенты с фидом `<сервер>/download/` продолжают обновляться (electron-updater разрешает `releases/<ver>/…` относительно своего фида и идёт по редиректу). Исключения из «тот же путь» (`/tmp/download.caddy`, генерирует `entrypoint.sh`): `/download/mac-arm64|mac-x64|win|linux|deb` → 302 на `https://<RELEASES_HOST>/latest/<файл>`; `/download/` (и `/download` через 308) — по `User-Agent`: `Macintosh` → mac-arm64, `Windows` → win, `Linux`/`X11` (кроме Android/ChromeOS) → AppImage, иначе → `https://<LANDING_HOST>/#download`. На самом хосте релизов корень, листинги (`*/`) и `/index.html` → 302 на `https://<LANDING_HOST>/#download` (если лендинг задан); `latest/*` — `no-cache` и `Access-Control-Allow-Origin: *` (лендинг читает `latest/VERSION`; его CSP `connect-src` включает `RELEASES_HOST`). Лендинг ссылается прямо на `latest/<файл>` и сам выбирает ОС в браузере. Без `RELEASES_HOST` (локальный `/srv/releases`) коротких путей нет. DNS: `releases.calab.ru` A → 141.105.69.177 (Cloudflare, DNS-only) — заведён вместе с зоной. На стенде до переключения на calab.ru `RELEASES_HOST=` (пусто, `/download/` локально).

**Что нужно от владельца** (в корневой `.env` репо — не коммитится; имена ключей — как у владельца):
| Ключ | Что |
|---|---|
| `S3_ENDPOINT`, `S3_REGION` (по умолчанию `ru-central1`), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Yandex Object Storage: бакет и ключ сервисного аккаунта **с правом записи в этот бакет** (сейчас — AccessDenied, выясняет лид); бакет — **публичное чтение** объектов |
| `S3_PUBLIC_URL` | публичный базовый URL бакета — для Caddy на стенде (`infra/docker/.env`), в GitHub не нужен |
| `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD` | Developer ID Application (.p12, base64) — Apple Developer Program |
| `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | ключ App Store Connect API (.p8, base64) для нотаризации |
| `WIN_CERT_P12_BASE64`, `WIN_CERT_PASSWORD` | сертификат подписи кода Windows (.pfx/.p12, base64) |
| `GITHUB_TOKEN` | только для авторизации `gh` в `set-secrets.sh`; в секреты **не** кладётся |
| `STAND_SSH_KEY`, `STAND_HOST`, `STAND_KNOWN_HOSTS` | (необязательно) запасная публикация на стенд — отдельный deploy-пользователь |
На стенд (`infra/docker/.env`): `RELEASES_HOST=releases.calab.ru`, `S3_PUBLIC_URL=…` → `sync.sh caddy`.

**Секреты в GitHub:** `infra/ci/set-secrets.sh [--dry-run] [.env]` — читает `.env` без `source` (никакого выполнения), берёт только ключи из таблицы (прочее, напр. `CFTOKEN`, игнорирует), ставит через `gh secret set --repo itrcz/calab`; авторизация — `GITHUB_TOKEN` из `.env`/окружения (как `GH_TOKEN`) или `gh auth login`. Для base64-сертификатов сообщает `valid`/`INVALID (…)` (та же проверка, что в workflow), значения не печатает; `--dry-run` — только имена, длины и валидность. Секреты передаются в `gh secret set` через stdin (флаг `--body -` сохранил бы буквальный «-» — так было до исправления, из-за чего rc.4/rc.5 собрались без подписи). На 2026-09-26 поставлены S3 (5) и Apple (6, включая `APPLE_TEAM_ID`); Windows — без сертификата, собирается неподписанным.

### Релиз: runbook (v0.1.0)

Одна команда на один коммит (`infra/docker/release.sh`); запуск — по решению лида, с указанием коммита. Серверная часть (API, веб, лендинг) выкатывается с Mac на стенд; установщики десктопа собирает и публикует **только** GitHub Actions (`release.yml`, запускается push-ем тега) → S3 → `https://releases.calab.ru/`. С Mac ничего десктопного не публикуется.

```sh
VERSION=0.1.0 infra/docker/release.sh <commit>          # preflight → web → deploy → verify → desktop
infra/docker/release.sh verify <commit>                  # только пост-проверки того, что задеплоено
STEPS="deploy verify" VERSION=0.1.0 infra/docker/release.sh <commit>   # часть шагов
STEPS="preflight build" VERSION=0.1.0 infra/docker/release.sh <commit> # локальная сборка всех ОС для проверки (не публикуется)
```

| Шаг | Что делает | Стоп-условие |
|---|---|---|
| preflight | тег `v$VERSION` свободен локально и в `origin`; в коммите есть `release.yml`; `gh` видит `itrcz/calab` (`GITHUB_TOKEN` из `.env` как `GH_TOKEN`); `pnpm install --frozen-lockfile --lockfile-only` на экспорте коммита; ≥ 5 GB свободно локально (≥ 15 GB с шагом `build`); стенд доступен; снимок чужой GPU-задачи; **бэкап до** | любое — выход |
| build | *(не по умолчанию)* `build-release.sh mac linux win` с `SIGN=1 NOTARIZE=1`, `SRC_REF=<commit>`, Linux/Windows на стенде → `$WORK_DIR/dist-release`; только для проверки, не публикуется | ошибка сборки |
| web | чистый экспорт коммита (`git archive` + `pnpm install --frozen-lockfile`, переиспользуется от `build`) → `build:web` → `dist-web`; при `LANDING_HOST` — `pnpm -F @calaba/landing build` → `apps/landing/out` | нет `index.html` |
| deploy | `sync.sh` с `SYNC_REF=<commit>`, `VERSION`, `WEB_DIST` и `LANDING_DIST` из этого экспорта (лендинг — всегда из релизного коммита, не из рабочей копии), `SKIP_RELEASES=1`: весь стек (api с build info; неизменённые сервисы не трогаются), веб, лендинг | ошибка деплоя |
| verify | все HTTP-проверки и e2e — напрямую на IP стенда (`curl --resolve`, принудительный DNS в браузере); smoke на `app.calab.ru` и `meet.gptunnel.ru`: `/healthz`, `/api/version` = `$VERSION/<commit>`, TLS (curl проверяет цепочку и имя, срок — из сертификата); лендинг — 200; `/download/latest.yml` на приложении, алиасе и лендинге — 302 на `https://releases.calab.ru/latest.yml`; `rtc.` — 200, `/readyz` изнутри; `e2e:web` **только на `app.calab.ru` и только Chromium** (Firefox и алиас — в nightly), аккаунт `e2e-app@calaba.test`, пространства `Web …` удаляются; сценарий перемещения M.1 (`move.web.spec.ts`, если есть в коммите; второй аккаунт `e2e-app2@calaba.test`; спек переиспользует «E2E web»); спеки и конфиг — из экспорта релизного коммита, не из рабочей копии; аккаунты создаются один раз по инвайту владельца, пароли — только в `.env.accounts`; relay-check tls/udp/any с токеном join из API + публикатор `lk load-test`; нет ERROR в api и «failed to send webhook» в LiveKit; чужая GPU-задача та же; **бэкап после** | считаются провалы |
| desktop | только если провалов нет: `git tag -a v$VERSION <commit>` и `git push origin v$VERSION` → ждёт прогон `release.yml` этого тега (`gh run watch`, ~40–60 мин: нотаризация mac); затем фид на `releases.calab.ru` (через IP стенда): `latest-mac/linux.yml`, `latest.yml` с `version: $VERSION`, каждый файл из них — 200 и размер из yml (≥ 5 файлов), `sha512` пересчитан **на стенде** (скачивает с `releases.calab.ru`); затем публикует GitHub Release токеном владельца: `release.yml` оставляет его черновиком (токен Actions получает 403 при публикации релиза тега, коммит которого меняет `.github/workflows`, — v0.1.0), тело — секция версии из `CHANGELOG.md`; если черновика нет — создаёт релиз из артефактов прогона; проверка: опубликован (не draft) | считаются провалы |

Логи e2e/relay/публикатора/Actions — рядом с `WORK_DIR` (`$TMPDIR/calaba-release-<ver>.*`). Секреты читаются по ssh в переменные и не печатаются. Нужны локально: `pnpm`, `gh`, `lk` (livekit-cli), Playwright-браузеры (`pnpm -F @calaba/desktop exec playwright install chromium firefox`); для `build` — Xcode CLT и сертификаты из `cert/`.

### Смена / добавление домена

1. A-записи `<домен>`, `rtc.<домен>`, `turn.<домен>` → 141.105.69.177, в Cloudflare — **DNS-only** (AAAA не заводить, пока нет IPv6 на хосте и правил для него). Проверить с машины без VPN (или DoH: `curl -s -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=turn.<домен>&type=A'`): VPN с fake-IP DNS и кэшем NXDOMAIN (SOA min 1800 с в зонах Cloudflare) может «не видеть» свежие записи до 30 мин.
2. На хосте в `/opt/calaba/infra/docker/.env`: `DOMAIN=<основной>`, `DOMAIN_ALT=<запасной или пусто>`; на время переезда старый основной — в `DOMAIN_LEGACY`, чтобы старые клиенты не оборвались.
3. `infra/docker/sync.sh` (или на хосте `deploy.sh`): Caddy пересоздаётся с новыми списками хостов и выпускает сертификаты; `livekit.gen.yaml` перерендерится (`turn.domain`) → LiveKit перезапустится сам (короткий обрыв медиа); API получит новые `PUBLIC_APP_URL`/`PUBLIC_APP_URL_ALT`/`LIVEKIT_URL`.
4. Клиентам — новый адрес сервера. Когда старые клиенты переехали — убрать `DOMAIN_LEGACY`, `sync.sh caddy`. Старые сертификаты в volume просто истекут.
5. Лимиты Let's Encrypt. Если упрёмся: задать `email` в глобальном блоке Caddyfile — тогда Caddy при неудаче LE автоматически пробует ZeroSSL (без email фолбэк на ZeroSSL не работает); либо явно `acme_ca`/`issuer zerossl`.

Домены стенда — см. «Стенд: как он поднят» и docs/10-branding.md.

## Dev локально (macOS)

`infra/docker/compose.dev.yml`: postgres, valkey, livekit (dev-режим: `--dev`, ключи `devkey/secret`, без TLS, UDP mux 7882, Valkey DB 1), egress (в сетевом пространстве livekit; файлы — `apps/server/data/recordings`, это `RECORDINGS_PATH` API по умолчанию). Образ egress ~1.5 ГБ: `docker compose -f infra/docker/compose.dev.yml up -d` без имён сервисов его скачает — если запись не нужна, поднимать `postgres valkey livekit mailpit`. API и Electron — на хосте через pnpm; файлы API в dev — `STORAGE_DRIVER=fs` с локальным каталогом (`infra/docker/data/` в `.gitignore`). LiveKit в Docker на macOS не имеет host-сети → для локальных тестов медиа между двумя машинами в LAN LiveKit лучше запускать бинарником (`brew install livekit`), в Docker — только для одного клиента на localhost.

## Потом: Kubernetes

Путь без переписывания:
1. Уже сейчас: всё через env, API stateless, health-эндпоинты `/healthz` `/readyz`, миграции при старте под `pg_advisory_lock` (безопасно для нескольких реплик).
2. k3s на одной ноде → Helm-чарты: свой `calaba-api`, официальный `livekit-server` (`hostNetwork`, Redis), `cloudnative-pg`, файлы — PVC (RWO, один API) или драйвер `s3` (Garage / внешний S3) при нескольких репликах, Traefik с `IngressRouteTCP HostSNI(turn.*)` passthrough.
3. Добавление нод: LiveKit масштабируется через Redis (комната закрепляется за нодой), API — обычными репликами, gateway — pub/sub уже через Redis.

Не использовать: private/serverless кластеры (NAT ломает WebRTC), LB перед 7881.

### Почта (ADR-0023)
- `.env` стенда: `SMTP_HOST=mail.unne.ai`, `SMTP_PORT=465`, `SMTP_TLS=tls`, `SMTP_USER` = `SMTP_FROM`-адрес, `SMTP_PASSWORD`, `SMTP_FROM="Calab <noreply@calab.ru>"`. Проверка: регистрация → письмо с кодом; в логах API `mail sent` / `mail: giving up`.
- **Владелец, DNS `calab.ru`**: SPF `v=spf1 include:<SPF почтового сервера mail.unne.ai> -all` (или `a:mail.unne.ai`); DKIM — TXT `<selector>._domainkey.calab.ru` с публичным ключом, которым подписывает mail.unne.ai; DMARC `_dmarc.calab.ru` → `v=DMARC1; p=quarantine; rua=mailto:<ящик отчётов>` (начать с `p=none` на неделю).

## Наблюдаемость

- LiveKit: `/metrics` Prometheus на `127.0.0.1:6789` (`prometheus.port` в шаблоне; `bind_addresses: 127.0.0.1` действует и на него, снаружи порт ещё и закрыт файрволом). Проверка с хоста: `curl -s 127.0.0.1:6789/metrics | grep -c '^livekit_'` (сейчас ~60 метрик). **Скрейп пока не настроен.** Prometheus на самом хосте нет: `prometheus-node-exporter` (:9100) скрейпит внешний Prometheus из подсетей Yandex Cloud (`84.201.128.0/18`, `51.250.0.0/17`, `178.154.192.0/18` — разрешены в iptables только для 9100/9400). Варианты подключения, по возрастанию изменений:
  1. Отдать метрики через Caddy: `rtc.<domain>` → `handle /metrics` → `reverse_proxy 127.0.0.1:6789` с `basic_auth` (или `remote_ip` этих подсетей); у внешнего Prometheus job `scheme: https`, `metrics_path: /metrics`, target `rtc.<domain>`. Файрвол и конфиг LiveKit не трогаем — предпочтительно.
  2. Отдельный порт: `prometheus.port` на публичном интерфейсе нельзя без смены `bind_addresses` (он же signal) → не делать.
  Дашборд — официальный LiveKit Grafana dashboard.
- API: `slog` JSON-логи, `/metrics` (client_golang): активные сокеты, события/с, латентность REST и fan-out. Только с хоста (`127.0.0.1:3000/metrics`); на `<домен>` Caddy отвечает 404. Подключать к внешнему Prometheus тем же способом, что и LiveKit (отдельный путь в Caddy с `basic_auth`).
- Клиент: crash-репорты (Sentry self-hosted — позже), локальный лог в `userData/logs`.

## Резервные копии

Работает на стенде с 2026-09-26: host systemd `calaba-backup.timer` (ежедневно 03:30 ± 5 мин, `Persistent=true` — пропущенный запуск догоняется) → `calaba-backup.service` → `infra/docker/backup/backup.sh`. Юниты лежат в репо (`infra/docker/backup/calaba-backup.{service,timer}`), на хост ставятся `install -m 644 … /etc/systemd/system/ && systemctl enable --now calaba-backup.timer`.

| Что | Куда (`/opt/calaba/backups`, 700 root) | Как |
|---|---|---|
| Postgres | `pg/calaba-<ts>.dump` | `pg_dump -Fc` через `docker exec`, проверка `pg_restore --list`, атомарный rename |
| Загруженные файлы (`calaba_files_data`) | `files/files-<ts>.tar.zst` | `tar` + `zstd` (файлы неизменяемы после записи — живой tar консистентен) |
| Caddy (`calaba_caddy_data`: ACME-аккаунт, сертификаты) | `caddy/caddy-<ts>.tar.zst` | чтобы после потери диска не упереться в лимиты LE |
| Секреты стенда (`infra/docker/.env`, `.env.accounts`) | `config/env-<ts>.tar.zst` | без них восстановленный стенд — другой (JWT, пароли БД/Redis, ключи LiveKit) |

- Ретенция 14 дней (`RETENTION_DAYS`), `.part`-остатки чистятся. Лог — `journalctl -u calaba-backup.service`. Предупреждение в журнал, если на ФС < 10 % свободно.
- **Offsite: TODO владелец.** Локальные копии спасают от логических ошибок (кривая миграция, удалённое пространство), но не от потери диска/хоста. `backup.sh` уже умеет: `OFFSITE_RCLONE_REMOTE=<remote:path>` в `infra/docker/.env` → `rclone sync` каталога бэкапов (rclone поставить на хост). Remote должен быть **rclone crypt** (в копиях секреты и данные пользователей).
- Восстановление — `infra/docker/backup/restore.sh`:
  - `restore.sh test [dump]` — восстановить в отдельную БД `calaba_restore_test`, сравнить число строк по всем таблицам с живой БД, удалить. Проверено 2026-09-26: 12 таблиц, счётчики совпали. Делать раз в месяц (TODO: отдельный таймер).
  - `restore.sh pg <dump>` — заменить живую БД (останавливает api, спрашивает подтверждение).
  - `restore.sh files <tar.zst>` — заменить файлы (останавливает api, `chown 65532`). Архив файлов проверен распаковкой: `diff -r` с живым volume — идентично.
  - Caddy/секреты — вручную: `zstd -dc … | tar -x` в volume `calaba_caddy_data` / в `infra/docker/`.
- Основной `rsync` в `sync.sh` каталог `/backups/` не трогает (иначе `--delete` стёр бы копии).
