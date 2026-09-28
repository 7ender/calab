# GPTunneL device API: что есть, что используем, что добавляем

Интеграция записи встреч (ADR-0025, docs/09 #47). Calab — «устройство» GPTunneL: сервер пространства держит device token (`gtd_…`, Bearer) и работает с REST `/v1/meetings/device/*`. Источник правды — репозиторий GPTunneL: `packages/server/src/routes/meetings/index.ts`, `services/meetings/*`, контракт `packages/shared/types/meetings.d.ts` (сверено с `main` 2026-09-27, `10ba134560`).

## 1. Что device token даёт сейчас

| Метод | Путь | Ответ |
|---|---|---|
| POST | `/v1/meetings/device/pair` `{code, name, platform: macos\|windows\|linux, app_version}` | `MeetingDeviceSession` c `token` (один раз), `device`, `user {id,name,email}`, `web_url` (база веба) |
| GET / DELETE | `/v1/meetings/device/me` | сессия без токена / 204 (отзыв) |
| POST | `/v1/meetings/device/recordings` `{client_id, title, kind: audio\|video, mime, size_bytes, duration_sec, started_at}` | `{id, offset}`; идемпотентно по `client_id` |
| HEAD / PUT | `/v1/meetings/device/recordings/:id/data` | `Upload-Offset`; куски ≤ 16 МБ, `Content-Range`, 409 + `Upload-Offset` |
| POST | `/v1/meetings/device/recordings/:id/complete` | статус (ниже) |
| GET | `/v1/meetings/device/recordings/:id` | `{id, status, error, offset, web_url}` |
| DELETE | `/v1/meetings/device/recordings/:id` | 204 |

- `status`: `uploading → uploaded → transcribing → summarizing → done`, либо `failed` (`error`: `insufficient_balance`, `account_unavailable`, `transcription_failed`, `summary_failed`, `empty_audio`, `storage_failed`, `internal`) или `cancelled`.
- `web_url` = `PUBLIC_APP_BASE_URL || DOMAIN || https://gptunnel.ru` + `/meetings/<id>`. На международном стенде база — `https://app.gptunnel.ai`, поэтому Calab нормализует хост (§4).
- Приём: `audio/mpeg`, `video/mp4` (Calab шлёт AAC в MP4 как `kind: video`); ≤ 4 ГБ, ≤ 4 ч; ≤ 3 незавершённых загрузки / 8 ГБ на пользователя (429 `too_many_uploads`).
- Ошибки: `{error, message}`; 401 `unauthorized` / `device_revoked`; неизвестный путь — 404 `not_found`.

**Чего нет.** Саммари, транскрипт (реплики со спикерами и таймингами), язык и файл записи хранятся у GPTunneL (`meeting_recording.summary`, `.transcript` — JSON `MeetingTranscriptSegment[]`, `.language`, `.file_url`), но отдаются только веб-сессии (tRPC `meetings.recording`). Device token видит лишь статус и ссылку.

## 2. Что используем в Calab

pair / me / DELETE me (вкладка «GPTunneL»), create + HEAD/PUT + complete (загрузка после записи), GET статуса (опрос до `done|failed`), `web_url` (кнопка «Открыть в GPTunneL»), `DELETE /recordings/:id` при «Удалить запись» в карточке (docs/09 #50; ошибку только логируем), и после `done` — два новых метода ниже: саммари в карточку, транскрипт в панель. Аудио для «Послушать запись» — **своё** (файл LiveKit Egress хранится у нас `RECORDING_KEEP_DAYS` дней как вложение карточки); `media_url` GPTunneL не используем.

## 3. Что добавить в GPTunneL (спецификация)

Оба метода — в тот же роутер `routes/meetings/index.ts`, авторизация `deviceAuth` (`Authorization: Bearer gtd_…`), доступ — только к записям **этого устройства** (`user_id` + `device_id` устройства, `delete_date IS NULL`, как `findDeviceRecording`); чужая, удалённая или несуществующая запись — 404 `not_found`. Статус записи не проверяется: поля отдаются, как только появились (транскрипт — после `transcribing`, саммари — после `summarizing`). Ответы — `Cache-Control: no-store`. Ошибки в общем формате `{error, message}`.

Отдельные методы, а не новые поля в `GET /recordings/:id`: статус опрашивается часто (раз в 20 с – 5 мин), а транскрипт 4-часовой встречи — сотни КБ.

### 3.1 `GET /v1/meetings/device/recordings/:id/result`

Итог обработки без транскрипта.

```http
GET /v1/meetings/device/recordings/66f5c0de8e1b2a0012ab34cd/result
Authorization: Bearer gtd_…
```

```json
{
  "id": "66f5c0de8e1b2a0012ab34cd",
  "status": "done",
  "error": null,
  "title": "Планёрка по релизу",
  "language": "ru",
  "duration_sec": 2520,
  "summary": "## Темы\n- Релиз 0.7\n\n## Решения\n- Выпускаем в пятницу\n\n## Задачи\n- **Аня**: обновить эталоны",
  "transcript_segments": 412,
  "speakers": 3,
  "media_url": "https://storage.gptunnel.ru/…/66f5….mp4",
  "mime": "video/mp4",
  "web_url": "https://gptunnel.ru/meetings/66f5c0de8e1b2a0012ab34cd"
}
```

| Поле | Тип | Значение |
|---|---|---|
| `id`, `status`, `error`, `web_url` | как в `GET /recordings/:id` | |
| `title` | string | название записи (LLM подставляет своё, если пользователь не переименовал) |
| `language` | string \| null | язык распознавания (`ru`, `en`, …) |
| `duration_sec` | number \| null | длительность по ffprobe сервера |
| `summary` | string \| null | сводка в Markdown (разделы «Темы / Решения / Задачи / Договорённости / Открытые вопросы»); `null`, пока не готова |
| `transcript_segments` | number \| null | число реплик; `null`, пока транскрипта нет |
| `speakers` | number \| null | число различных говорящих (`speaker` ≠ null); `null`, пока транскрипта нет |
| `media_url`, `mime` | string \| null, string | файл записи в хранилище GPTunneL (как `MeetingRecordingDetail.media_url`) |

Тип в контракте: `MeetingDeviceRecordingResult = MeetingDeviceRecordingStatus`-поля (без `offset`) + поля выше.

### 3.2 `GET /v1/meetings/device/recordings/:id/transcript?cursor=&limit=`

Реплики транскрипта постранично, в порядке времени.

```http
GET /v1/meetings/device/recordings/66f5c0de8e1b2a0012ab34cd/transcript?limit=2
Authorization: Bearer gtd_…
```

```json
{
  "id": "66f5c0de8e1b2a0012ab34cd",
  "language": "ru",
  "total": 412,
  "segments": [
    { "speaker": 0, "start": 0.48, "end": 6.9, "text": "Коллеги, начнём с релиза." },
    { "speaker": 1, "start": 7.2, "end": 12.05, "text": "Эталоны пересняли, осталось два экрана." }
  ],
  "next_cursor": "2"
}
```

- `segments[]` — ровно `MeetingTranscriptSegment`: `speaker` — номер говорящего от распознавания (0, 1, …; `null` без разметки), `start`/`end` — секунды от начала записи (дробные), `text`.
- `cursor` — непрозрачная строка из `next_cursor` предыдущей страницы (сейчас — индекс первой реплики страницы); без `cursor` — с начала. `next_cursor: null` — последняя страница.
- `limit` — 1…2000, по умолчанию 500. Страница ≤ ~150 КБ JSON.
- `total` — всего реплик. Транскрипт может замениться целиком при повторе обработки в вебе: если `total` изменился между страницами, клиент начинает заново.
- Ошибки: 400 `bad_request` (`limit` вне 1…2000, `cursor` не число ≥ 0), 404 `not_found`, **409 `not_ready`** — транскрипта ещё нет (новый код в `MeetingDeviceApiErrorCode`). `cursor` ≥ `total` — 200 с пустыми `segments` и `next_cursor: null`.
- Пустые `?cursor=` / `?limit=` — как отсутствующие; параметры проверяются до поиска записи (400 раньше 404). Пустой транскрипт (`[]`) — 200 с `total: 0`.

### 3.3 Реализация в GPTunneL

Сделано по этой спецификации: репозиторий GPTunneL, ветка `feat/meetings-device-api-transcript` (worktree `gptunnel/.claude/worktrees/calab-device-api`, коммит `76dd787a41`): `routes/meetings/index.ts`, `services/meetings/{recordings,dto}.ts`, типы `MeetingDeviceRecordingResult`, `MeetingDeviceTranscriptPage`, код `not_ready` в `packages/shared/types/meetings.d.ts`, тесты `__tests__/{recordings,dto}.test.ts`. До выкатки на gptunnel.ru Calab получает 404 и работает по §5.

**Проверено на проде 27.09** (gptunnel.ru и gptunnel.ai — один бэкенд): device token пространства стенда, запись 5 мин — `GET …/result` → 200, `Cache-Control: no-store`, поля ровно как в §3.1 (`summary` 1951 символ, `transcript_segments: 39`, `speakers: 2`, `language: "ru"`, `media_url`, `mime: "video/mp4"`); `GET …/transcript?limit=3` → `{id, language, total: 39, segments[{speaker, start, end, text}], next_cursor: "3"}`; клиент Calab (`gptunnel.Client.Result/Transcript`) читает всё без правок. `web_url` у прода — `https://app.gptunnel.ai/meetings/<id>` и на хосте gptunnel.ru: нормализация §4 нужна.

### 3.4 Лимиты

Отдельного лимита частоты нет (как у остальных методов устройства); клиенты читают результат один раз после `done` и при повторе. Calab: после `done` — `result`, затем все страницы `transcript` по 2000, кэширует у себя и больше не спрашивает; если ответ 404 на новый путь (старый GPTunneL) или 5xx — повторяет с backoff ≈ 3,5 суток (1 мин … 24 ч), затем прекращает.

## 4. Домен

- Calab: `GPTUNNEL_API_URL` по умолчанию `https://gptunnel.ru`; ссылки в UI — на `https://gptunnel.ru`.
- `web_url` из API нормализуется: хост `app.gptunnel.ai` (и `gptunnel.ai`) заменяется на `GPTUNNEL_WEB_URL` (по умолчанию `https://gptunnel.ru`), путь сохраняется. Другие хосты не трогаем (свой стенд GPTunneL).

## 5. Деградация в Calab

| Ответ GPTunneL | Карточка |
|---|---|
| `result` 200 с `summary` | саммари в карточке |
| `transcript_segments` > 0 и страницы получены | кнопка «Полный транскрипт» |
| 404 / нет поля / `null` | кнопки саммари и транскрипта скрыты; остаётся «Послушать запись» (свой файл; «Открыть в GPTunneL» в карточке убрана — docs/09 #80) |
| 401 | интеграция отключена (как при загрузке), результат не запрашивается |

## 6. Хотелось бы позже (не блокирует)

- Имена говорящих (`speaker_names: {"0": "Аня"}`) — Calab может передать участников звонка при create (`participants: [{name, joined_at, left_at}]`).
- Webhook вместо опроса статуса; приём `audio/ogg`.
