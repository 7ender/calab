# Build context: repo root (see infra/docker/compose.yml).
FROM golang:1.26-alpine@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c AS build
WORKDIR /src
COPY apps/server/go.mod apps/server/go.sum* ./
RUN go mod download
COPY apps/server/ ./
# Build stamp (GET /api/version); compose passes CALABA_VERSION / CALABA_COMMIT.
ARG VERSION=dev
ARG COMMIT=unknown
RUN CGO_ENABLED=0 go build -trimpath -tags nodynamic \
      -ldflags="-s -w -X github.com/calaba/calaba/server/internal/buildinfo.Version=${VERSION} -X github.com/calaba/calaba/server/internal/buildinfo.Commit=${COMMIT}" \
      -o /out/server ./cmd/server \
 && mkdir -p /out/data/files

# Soundboard uploads (ADR-0036) are converted by ffmpeg: a minimal static build — decoders for
# MP3 / Ogg (Vorbis, Opus) / WAV, the libopus encoder, the loudnorm filter, the Ogg muxer and
# the file protocol only (no network, no video, no other formats). ~3 MB instead of the ~80 MB
# of a full static ffmpeg; it runs in the distroless image below (no libc needed).
FROM golang:1.26-alpine@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c AS ffmpeg
ARG OPUS_VERSION=1.5.2
ARG OPUS_SHA256=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
ARG FFMPEG_VERSION=7.1.2
ARG FFMPEG_SHA256=089bc60fb59d6aecc5d994ff530fd0dcb3ee39aa55867849a2bbc4e555f9c304
RUN apk add --no-cache build-base curl nasm pkgconf xz
WORKDIR /build
RUN curl -fsSLo opus.tar.gz "https://downloads.xiph.org/releases/opus/opus-${OPUS_VERSION}.tar.gz" \
 && echo "${OPUS_SHA256}  opus.tar.gz" | sha256sum -c - \
 && tar xzf opus.tar.gz && cd "opus-${OPUS_VERSION}" \
 && ./configure --prefix=/opt --disable-shared --enable-static --disable-doc --disable-extra-programs \
 && make -j"$(nproc)" && make install
RUN curl -fsSLo ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
 && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
 && tar xJf ffmpeg.tar.xz && cd "ffmpeg-${FFMPEG_VERSION}" \
 && PKG_CONFIG_PATH=/opt/lib/pkgconfig ./configure --prefix=/opt \
      --pkg-config-flags=--static --extra-cflags=-I/opt/include --extra-ldflags="-L/opt/lib -static" \
      --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug \
      --disable-ffplay --disable-ffprobe --disable-avdevice --disable-swscale \
      --enable-static --disable-shared --enable-libopus \
      --enable-protocol=file \
      --enable-demuxer=mp3,ogg,wav \
      --enable-parser=mpegaudio,opus,vorbis \
      --enable-decoder=mp3,mp3float,vorbis,opus,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_u8,pcm_alaw,pcm_mulaw,adpcm_ms,adpcm_ima_wav \
      --enable-encoder=libopus --enable-muxer=ogg \
      --enable-filter=abuffer,abuffersink,aformat,anull,aresample,atrim,loudnorm \
 && make -j"$(nproc)" ffmpeg && strip ffmpeg && install -m 0755 ffmpeg /opt/bin-ffmpeg

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/server /server
COPY --from=ffmpeg /opt/bin-ffmpeg /usr/local/bin/ffmpeg
# License terms travel with the binary (BUSL-1.1: LICENSE, NOTICE with the attribution
# requirement, commercial terms) plus the licenses of bundled Go modules.
COPY LICENSE NOTICE COMMERCIAL-LICENSE.md /
COPY apps/server/THIRD-PARTY-NOTICES.txt /THIRD-PARTY-NOTICES.txt
# ffmpeg (LGPL-2.1+, built without GPL parts) and libopus (BSD-3-Clause): their sources are the
# pinned release tarballs above.
COPY --from=ffmpeg /build/ffmpeg-7.1.2/COPYING.LGPLv2.1 /licenses/ffmpeg-COPYING.LGPLv2.1
COPY --from=ffmpeg /build/opus-1.5.2/COPYING /licenses/opus-COPYING
# STORAGE_PATH=/data/files (ADR-0011). Owned by nonroot (65532) so a fresh named volume
# mounted here inherits writable ownership.
COPY --from=build --chown=65532:65532 /out/data /data
ENV STORAGE_DRIVER=fs STORAGE_PATH=/data/files FFMPEG_PATH=/usr/local/bin/ffmpeg
ENTRYPOINT ["/server"]
