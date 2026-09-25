# ADR-0001: Desktop на Electron (2026-09-25)

## Контекст
Нужен кросс-платформенный клиент (macOS/Windows/Linux) с тяжёлым WebRTC: AEC, AV1/SVC, захват экрана, loopback системного звука, глобальный push-to-talk. Рассматривали Electron и Tauri.

## Решение
Electron 44 (текущий stable), `electron-vite`, React, TypeScript.

## Почему не Tauri
- Linux: WebKitGTK без пригодного WebRTC (wry#85).
- macOS: WKWebView — ограниченный `getDisplayMedia`, нет управления AV1/SVC.
- Поведение AEC и кодеков отличалось бы на каждой ОС; Electron даёт один Chromium везде.

## Последствия
- Размер дистрибутива ~100+ MB, RAM ~200–300 MB — приемлемо для корпоративного десктопа.
- Строгая модель безопасности: `contextIsolation`, `sandbox`, renderer без Node, узкий preload.
- Нативные модули (uiohook-napi) требуют пересборки под Electron ABI (`electron-rebuild`).
