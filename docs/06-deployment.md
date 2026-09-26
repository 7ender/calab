# 06 — Деплой

## Сейчас: docker compose на одном хосте

Тестовый стенд: `root@141.105.69.177` (Debian 13, 32 vCPU, 123 GB RAM, 1.2 TB свободно, Docker 29, Compose v5).

**На хосте уже крутится GPU-задача** (`python` pid 3695 ~40 % RAM, `ffmpeg`, headless `chromium`, `Xvfb`; порты 8000/8001/8190/8210–8213/8300/8400/9100/9400, UDP 9001/9002). **Не трогаем.** Наши порты (80/443/7881/7882) с ними не пересекаются. RAM: ставим лимиты контейнерам (postgres 2G, api 1G, livekit 4G) чтобы не конкурировать; логи контейнеров ротируются.

Состав `infra/docker/compose.yml`:

| Сервис | Образ | Сеть | Заметки |
|---|---|---|---|
| caddy | своя сборка `infra/docker/caddy/Dockerfile` (`caddy:2.11.4` + `caddy-l4` v0.1.2, обе версии запинены; `entrypoint.sh` собирает списки хостов из `DOMAIN`/`DOMAIN_ALT`/`DOMAIN_LEGACY`) | host | 80/443 TCP, ACME, `Caddyfile`, layer4 как listener wrapper (SNI `turn.*`), h3 выключен |
| livekit | `livekit/livekit-server:v1.13` | host | signal 7880 (только 127.0.0.1), 7881/tcp, 7882/udp, TURN 443/udp, TURN 5349 (`external_tls`; слушает `*:5349` — LiveKit не умеет bind для TURN, снаружи закрыт файрволом), metrics 6789 (127.0.0.1) |
| api | `apps/server/Dockerfile` (Go → distroless static, nonroot) | **host**, `HTTP_ADDR=127.0.0.1:3000` | ходит в Postgres/Redis/LiveKit по 127.0.0.1; миграции сам при старте; файлы — `STORAGE_DRIVER=fs`, volume `files_data` → `/data/files` (ADR-0011; каталог создан в образе с владельцем nonroot 65532, свежий named volume наследует его — отдельный chown не нужен); healthcheck — `/server healthcheck` |
| postgres | `postgres:18-alpine` | bridge, `127.0.0.1:5432` | PG 18 — встроенный `uuidv7()`; volume на `/var/lib/postgresql` |
| redis | `redis:7.4-alpine` | bridge, `127.0.0.1:6379` | AOF; healthcheck `redis-cli ping` |

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
- Домены (с 2026-09-25): `DOMAIN=colaba.gptunnel.ai` (основной), `DOMAIN_ALT=colaba.gptunnel.ru` (запасной алиас) — 6 имён, сертификаты Let's Encrypt на все выпускает Caddy (volume `calaba_caddy_data`, при передеплое не перевыпускаются). Детали и ограничение по TURN — docs/03-network.md, «Несколько доменов». История: первые пробы шли на `*.141-105-69-177.sslip.io`, после переезда эти имена оставались в `DOMAIN_LEGACY` и сняты 2026-09-25 — больше не обслуживаются.
- DNS — Cloudflare (зоны `gptunnel.ai`, `gptunnel.ru`), A-записи `colaba` (приложение), `rtc.colaba`, `turn.colaba` → 141.105.69.177, **proxied=false** (DNS-only), TTL auto. Токен Cloudflare — только у владельца/в локальном `.env` репо (`CFTOKEN`, gitignored), на сервер не копируется.
- Весь стек (с api) поднят 2026-09-25: `infra/docker/sync.sh` без аргументов; отдельный сервис — `infra/docker/sync.sh api`. Миграции применились при старте api.
- Регистрация **только по приглашению** (`REGISTRATION_MODE=invite`, с 2026-09-26 — security review H2); бессрочный инвайт владельца в workspace `team` (10 использований) — в `/opt/calaba/infra/docker/.env.accounts` (строка `invite`). Тестовые аккаунты `owner@calaba.test` / `bob@calaba.test` (workspace `team`), пароль — `/opt/calaba/infra/docker/.env.accounts` (600; `sync.sh` не трогает `.env*`). 
- Снаружи через Caddy доступны только `<домен>` (API + веб-клиент; `/metrics` и `/readyz` закрыты — 404, изнутри `127.0.0.1:3000/metrics`, `127.0.0.1:3000/readyz`; снаружи для мониторинга — `/healthz`), `rtc.*` (signal), `turn.*` (TURN/TLS).

### Защита стенда (security review 2026-09-26)

- Контейнеры api/caddy/postgres/redis: `read_only: true` + tmpfs `/tmp`, `cap_drop: [ALL]`, `no-new-privileges`. Caddy — только `NET_BIND_SERVICE` (80/443); postgres и redis запускаются сразу своими пользователями (`70:70`, `999:1000`) — без gosu и без capabilities; api — distroless nonroot 65532. LiveKit пока без этого (host network, TURN на 443/udp) — TODO.
- Лимиты памяти: api 1G, caddy 512m, postgres 2G, redis 768m (`maxmemory 512mb`), livekit 4G.
- Redis: пароль (`REDIS_PASSWORD` в `.env`, в `REDIS_URL` api), пароль передаётся через конфиг в tmpfs, а не в argv (не виден в `ps` на общем хосте); `maxmemory-policy noeviction` — сессии/отзывы/буферы gateway нельзя терять молча (при нехватке — ошибки записи, видно в логах).
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
- API разрешает браузерные origin-ы `PUBLIC_APP_URL` и `PUBLIC_APP_URL_ALT` (cookie-refresh, CSRF-проверка, upgrade gateway). `DOMAIN_LEGACY` в этот список **не входит** — веб-клиент по legacy-именам работать не будет (десктоп — будет).
- Манифест PWA: `*.webmanifest` отдаётся как `application/manifest+json` (в MIME-таблице Go его нет — Caddy ставит заголовок явно), `*.svg` — `image/svg+xml`.
- Публикация статики без перезапуска: `infra/docker/sync.sh` (если `apps/desktop/dist-web` есть локально). Флаг `SKIP_WEB=1` — не трогать опубликованную статику (например, пока сборка не готова).

### Релизы десктопа: `/download/` (фид electron-updater)

- `https://<домен>/download/` → статика из `/opt/calaba/releases` (bind mount `../../releases:/srv/releases:ro` в caddy), листинг каталога (`file_server browse`) включён только здесь; `/download` → 308 на `/download/`. Это же — фид electron-updater (generic provider, `url: https://colaba.gptunnel.ai/download/`).
- Кэш: `latest*.yml`, `*.yaml`, `*.json` и листинги — `no-cache` (меняются на месте); установщики и `*.blockmap` (версия в имени) — `public, max-age=31536000, immutable`. Типы: `*.yml` — `text/yaml`, `*.dmg/*.AppImage/*.deb/*.exe/*.blockmap` — `application/octet-stream` (в MIME-таблице Go их нет), `*.zip` — `application/zip`. Range (206) работает — докачка и differential-обновления. Сжатие здесь выключено.
- Публикация: `sync.sh` — если локально есть `apps/desktop/dist-release/`, копирует `*.dmg *.zip *.AppImage *.deb *.exe *.blockmap latest*.yml *.json` в `/opt/calaba/releases` **без `--delete`** (старые версии остаются доступными) и с `--delay-updates` (`latest*.yml` появляется вместе с установщиками, updater не увидит ссылку на ещё не залитый файл). `SKIP_RELEASES=1` — пропустить. Основной `rsync` репо каталог `/releases/` не трогает. Удалять старые версии — вручную на хосте.
- Имена файлов с версией обязательны (immutable-кэш): перезалить тот же файл с тем же именем нельзя — только новая версия.
- Проверки и ожидаемые выводы — `TESTING.md`, раздел «Стенд».

### Релизы десктопа: сборка

Все три ОС собираются с одного Mac (Apple Silicon): `apps/desktop/scripts/build-release.sh [mac] [linux] [win]` (без аргументов — все).

- **Источник** — чистый `git archive` коммита `SRC_REF` (по умолчанию `HEAD`) во временном каталоге (`WORK_DIR`, по умолчанию `$TMPDIR/calaba-release`): незакоммиченные правки не попадают в релиз, рабочее дерево и `node_modules` разработчика не трогаются. Версия — из `apps/desktop/package.json`; `VERSION=1.2.3` переопределяет её только в экспорте (`npm version --no-git-tag-version`), в репо ничего не меняется.
- **macOS** — нативно, `electron-builder --mac --universal` (dmg + zip, arm64+x64 в одном приложении). Нативный `uiohook-napi` с нашим патчем (`patches/uiohook-napi@1.5.5.patch`, pnpm `patchedDependencies`) electron-builder компилирует из исходников под каждую архитектуру в `build/Release`; скрипт проверяет, что патч применён, убирает `bin/` (копия postinstall только под хост-арх — иначе `@electron/universal` отказывается склеивать) и чужие `prebuilds/`, после сборки проверяет `lipo -archs` → `x86_64 arm64`. Требуется Xcode Command Line Tools.
- **Windows на Apple Silicon — только через x86_64-хост.** electron-builder запускает NSIS-установщик под wine, чтобы сгенерировать деинсталлятор; стаб NSIS 32-битный, Rosetta в Docker покрывает только x86_64, и wine уходит в qemu-i386, где падает (`anon_mmap_fixed … host_page_mask`). Поэтому на arm64-Mac скрипт требует `WIN_DOCKER_HOST=ssh://user@host` — любой x86_64 Linux с Docker: исходники уходят туда `rsync`, контейнер запускается с `--cpus 4 --memory 6g` (`REMOTE_CPUS`/`REMOTE_MEMORY`) и низким приоритетом CPU/IO (`--cpu-shares 128 --blkio-weight 10` — аналог nice/ionice для контейнера), артефакты возвращаются, временный каталог удаляется. Без него `win` пропускается с предупреждением (код выхода 2). На Intel-Mac/Linux-машине всё собирается локально.
- **Linux (AppImage + deb, x64) и Windows (NSIS, x64)** — в Docker: `electronuserland/builder:wine` (Ubuntu 22.04, Node 24, wine/mono), запинен по digest, `--platform linux/amd64` (на Apple Silicon — эмуляция). Исходники копируются внутрь контейнера (без `node_modules`), `pnpm install --frozen-lockfile --ignore-scripts`, `electron-vite build`, `electron-builder --linux --win --x64` с `npmRebuild=false`. `uiohook-napi` здесь — N-API prebuilds из пакета (`prebuilds/linux-x64`, `prebuilds/win32-x64`): наш патч меняет только macOS-хук, а нативный код под Windows из Linux не собрать. Кэши pnpm/Electron — docker volumes `calaba-release-pnpm-store`, `calaba-release-electron-cache`. Требуется Docker Desktop (≈ 4.7 GB образ).
- **Результат** — `apps/desktop/dist-release/` (в `.gitignore`): `Calaba-<ver>-universal.dmg/.zip`, `Calaba-<ver>-x86_64.AppImage`, `calaba_<ver>_amd64.deb`, `Calaba-Setup-<ver>-x64.exe`, `*.blockmap`, `latest-mac.yml`, `latest-linux.yml`, `latest.yml`. Имена без пробелов и всегда с версией — `/download/` кэширует установщики как immutable. В `latest*.yml` и `app-update.yml` — generic-фид `UPDATE_URL` (по умолчанию `https://colaba.gptunnel.ai/download/`; клиент всё равно берёт фид с сервера, к которому подключён).
- **Публикация** — `SKIP_WEB=1 infra/docker/sync.sh` (копирует `dist-release` в `/opt/calaba/releases`, без удаления старых версий; см. «Релизы десктопа: `/download/`»). Перед публикацией поднять версию (`VERSION=` при сборке или в `package.json`): electron-updater обновляет только на бо́льшую версию.
- **Linux smoke** — после сборки AppImage распаковывается (squashfs по смещению из ELF-заголовка: сам рантайм AppImage под Rosetta/qemu не запускается — его маркер `AI` в ELF-заголовке binfmt не принимает) и приложение стартует под Xvfb; проверка — процесс жив через 20 с и есть X-окно «Calaba» (`xwininfo`). `build-release.sh smoke` — только smoke, `SMOKE=0` — пропустить.
- **Замеры (2026-09-26, M-series Mac, v0.0.1, main 8db0d7d):** macOS universal — 58 с (при прогретом кэше Electron; dmg 220 MB, zip 220 MB); Linux — 1 мин 45 с в Docker (эмуляция amd64; AppImage 122 MB, deb 97 MB); Windows — 1 мин 28 с на стенде через `WIN_DOCKER_HOST=ssh://root@141.105.69.177` (`--cpus 4 --memory 6g --cpu-shares 128 --blkio-weight 10`, нагрузка хоста выросла с 3.3 до 4.7 из 32; NSIS 109 MB, не подписан — таблица сертификатов PE пуста). Образ builder (6.3 GB) и кэш-volume `calaba-release-*` оставлены на стенде для повторных сборок; контейнеры удаляются (`--rm`), временный каталог — тоже. Первый запуск дольше: образ builder ≈ 4.7 GB, загрузка Electron-дистрибутивов в кэш.

**Подписи нет** (сборки для тестов):
- macOS: `identity: null` → Gatekeeper: «приложение от неустановленного разработчика» — открыть через ПКМ → «Открыть» (или `xattr -dr com.apple.quarantine /Applications/Calaba.app`). Автообновление на macOS **не работает без подписи** (Squirrel.Mac проверяет подпись) — клиент в этом случае только сообщает о новой версии. Нужно от владельца: **Apple Developer Program** (99 $/год) → сертификат *Developer ID Application* (.p12 → `CSC_LINK`, `CSC_KEY_PASSWORD`) и нотаризация (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` или App Store Connect API key); в `electron-builder.yml` убрать `identity: null`, включить `notarize`. Hardened runtime и entitlements уже настроены.
- Windows: без подписи SmartScreen показывает «Windows защитила ваш компьютер» → «Подробнее» → «Выполнить в любом случае»; репутация копится только у подписанных сборок. Нужно: сертификат подписи кода (OV или EV; с 2023 года ключ только на токене/HSM — практичнее облачная подпись: Azure Trusted Signing, SSL.com eSigner, DigiCert KeyLocker) → `win.signtoolOptions`/`azureSignOptions` в `electron-builder.yml`, секреты в env. Подписывать из Linux-контейнера можно облачными сервисами (osslsigncode/jsign), локальный токен требует Windows-машины.
- Linux: подпись не нужна (AppImage/deb без подписи — норма; при желании — GPG-подпись .deb/репозитория).

### Смена / добавление домена

1. A-записи `<домен>`, `rtc.<домен>`, `turn.<домен>` → 141.105.69.177, в Cloudflare — **DNS-only** (AAAA не заводить, пока нет IPv6 на хосте и правил для него). Проверить с машины без VPN (или DoH: `curl -s -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=turn.<домен>&type=A'`): VPN с fake-IP DNS и кэшем NXDOMAIN (SOA min 1800 с в зонах Cloudflare) может «не видеть» свежие записи до 30 мин.
2. На хосте в `/opt/calaba/infra/docker/.env`: `DOMAIN=<основной>`, `DOMAIN_ALT=<запасной или пусто>`; на время переезда старый основной — в `DOMAIN_LEGACY`, чтобы старые клиенты не оборвались.
3. `infra/docker/sync.sh` (или на хосте `deploy.sh`): Caddy пересоздаётся с новыми списками хостов и выпускает сертификаты; `livekit.gen.yaml` перерендерится (`turn.domain`) → LiveKit перезапустится сам (короткий обрыв медиа); API получит новые `PUBLIC_APP_URL`/`PUBLIC_APP_URL_ALT`/`LIVEKIT_URL`.
4. Клиентам — новый адрес сервера. Когда старые клиенты переехали — убрать `DOMAIN_LEGACY`, `sync.sh caddy`. Старые сертификаты в volume просто истекут.
5. Лимиты Let's Encrypt. Если упрёмся: задать `email` в глобальном блоке Caddyfile — тогда Caddy при неудаче LE автоматически пробует ZeroSSL (без email фолбэк на ZeroSSL не работает); либо явно `acme_ca`/`issuer zerossl`.

Домен стенда: `colaba.gptunnel.ai` (+ алиас `colaba.gptunnel.ru`), см. «Стенд: как он поднят».

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
