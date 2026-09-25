# @calaba/desktop — Electron client (stage 1: media spike)

Right now this is the **media spike**: one window that proves the media pipeline (mic → AEC3 → RNNoise/VAD → LiveKit, screen share with AV1/SVC, adaptive stream, stats) before the real UI exists. The structure (`main` / `preload` / `renderer/{app,features,lib/media}`) is already the one the full app will use.

Rules this code follows: `docs/02-media.md` (the echo-cancellation rules are mandatory), ADR-0001/0004/0005.

## Running

```bash
pnpm install                                                  # also rebuilds uiohook-napi for Electron
docker compose -f infra/docker/compose.dev.yml up -d livekit  # LiveKit --dev on ws://127.0.0.1:7880 (devkey/secret)
pnpm -F @calaba/desktop dev                                   # one window
CALABA_SPIKE_WINDOWS=2 pnpm -F @calaba/desktop dev            # two windows in one process (local loopback test)
```

Checks: `pnpm -F @calaba/desktop typecheck`, `lint`, `test` (VAD gate unit tests), `build` (electron-vite → `out/`), `dist` (electron-builder: mac dmg/zip, win nsis, linux AppImage+deb, unsigned).

### Environment variables

| Variable | Purpose |
|---|---|
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | **SPIKE ONLY**: keys for minting a dev token in main (default `devkey`/`secret`, as in `livekit --dev`). In the real app the token comes from the API. |
| `CALABA_SPIKE_WINDOWS=N` | open N windows at startup (1–4) |
| `CALABA_FAKE_MEDIA=1` | Chromium fake devices (the mic is a beep, no prompts). For automation only. **Warning:** in this mode "system audio" is also fake. |
| `CALABA_MAC_SYSTEM_AUDIO=0` | do not enable the Chromium features `MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride` |
| `REMOTE_DEBUGGING_PORT=9333` | (electron-vite) CDP for automated runs. In dev, `window.__spike = { session, store }` is available. |

## What each control does

**Room**: LiveKit URL, room, display name. "Подключиться" (Connect) mints a token in main (SPIKE ONLY), connects with `adaptiveStream: true`, `dynacast: true`, `webAudioMix: false`, then starts and publishes the mic. "+ окно" (+ window) opens another spike window.

**Mic**
- *Input device*: `getUserMedia({ echoCancellation: true, autoGainControl: true, noiseSuppression: !rnnoise, channelCount: 1 })` from `@calaba/protocol` `audioCaptureConstraints`.
- *Тест микрофона* (Test mic): starts capture without connecting, for tuning the threshold.
- *Активация голосом* (Voice activation): a speech frame is `level > threshold` **and** (when RNNoise is on) `RNNoise VAD ≥ 0.6`. The gate opens after 2 consecutive 20 ms frames and closes after 400 ms without speech. Closed → `track.mute()`: the track stays published and DTX sends almost nothing (measured: 0.1 kbps).
- *Push-to-talk*: "Назначить клавишу" (Assign key) captures the next global key (or mouse button 3+). Esc cancels. Down → unmute; up → mute after 200 ms. The hook (`uiohook-napi`) lives in main and starts only on first use. macOS needs Accessibility / Input Monitoring; there are buttons that open the right System Settings panes.
- *RNNoise*: an AudioWorklet (`lib/media/worklets/mic-processor.worklet.ts`) that runs after AEC3. While it is on, Chromium's built-in NS is off. Toggling rebuilds capture and calls `replaceTrack` without republishing.
- *Opus bitrate* 16/24/32/48/64 kbps, *RED*: changing either republishes the same track (both are negotiated at publish time).
- *Output device*: `setSinkId` on every remote `<audio>`. There is no WebAudio on the output path.

**Screen share**
- *Preset*: from `SCREEN_SHARE_PRESETS` (economy 720p5 0.4 Mbps / 720p15 1.0 / 1080p15 2.0 / original 30 fps 4.0).
- *Content (contentHint)*: `detail` | `motion`.
- *Codec*: AV1 (default, `backupCodec: false`), VP9, H.264 (simulcast).
- *Scalability (SVC)*: `auto` (by contentHint per ADR-0005), `L1T3`, `L2T3_KEY`, `L3T3_KEY`, `L1T1`, `L1T3 + simulcast 360p`. **Important:** livekit-client 2.22 forces `L1T3` and `contentHint='motion'` on any *non-simulcast* SVC screen share, so the first four options actually behave the same (see the spike results in docs/02-media.md). The panel shows the effective mode and hint.
- *System audio*: `setDisplayMediaRequestHandler` with `audio: 'loopbackWithMute'` plus `restrictOwnAudio: true`. On macOS it works, but it **does not exclude our own audio** (measured), so it is off by default and the UI warns about it. If capture with audio fails, the app falls back to video only and shows the reason.
- The picker lists screens and windows with `desktopCapturer` thumbnails, plus two **test sources** (static code / scrolling code on a canvas) for repeatable measurements that need no Screen Recording permission.
- Changing a setting while sharing restarts the publication with the same source.

**Participants**: speaking indicator (`isSpeaking` / `ActiveSpeakersChanged`), mic state, per-participant volume (`element.volume`). **Participant streams**: a 320×180 tile; click to expand it. The element size drives adaptive stream, and the stats panel shows which layer arrives.

**Stats** (1 s, `getStats()`): total in/out over the ICE transport; candidate pair (host/srflx/prflx/relay, protocol, RTT); CPU of this window's renderer, the GPU process and main, **in % of one core** (Electron's `percentCPUUsage` on macOS is normalised to all cores, so we multiply by the core count; checked against `ps`). Mic: codec, bitrate, RTT, jitter and loss from the SFU RR. Screen: for each layer/rid, codec, encoder (HW/SW), resolution@fps, bitrate/target, `qualityLimitationReason`, scalabilityMode. Incoming: audioLevel, jitter, loss, concealment; video: decoder, received resolution@fps, element size, bitrate.

## Implementation notes

- **RNNoise: `@timephy/rnnoise-wasm`** (RNNoise 0.2, synchronous WASM that works inside an AudioWorklet). `@sapphi-red/web-noise-suppressor` was rejected because its worklet throws away the VAD probability `rnnoise_process_frame`, and we need that for voice activation. Our own worklet imports the package internals through the `@rnnoise-dist` alias (see `electron.vite.config.ts`). The CSP includes `'wasm-unsafe-eval'` for it.
- `tsconfig.web.json` turns off `exactOptionalPropertyTypes`: the livekit-client types (`LocalTrack.processor?`) are incompatible with it.
- In dev, any change reloads the whole renderer (the `fullReloadOnly` plugin). Partial HMR would duplicate the module singletons (Room/AudioContext).
- The worklet dependencies are listed in `optimizeDeps.include`. Otherwise Vite discovers them on the first mic start and reloads the page in the middle of `connect()`.
- Security: `contextIsolation`, `sandbox`, `nodeIntegration: false`, a narrow `window.calaba` (`src/preload/api.d.ts`), IPC accepted only from our own origin, a permission allowlist (`media`, `display-capture`, `speaker-selection`, `fullscreen`), navigation and popups blocked.
- `// SPIKE ONLY`: `src/main/token.ts` and `livekit-server-sdk` in main. Delete them in stage 2.
