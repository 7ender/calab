# Build context: repo root (see infra/docker/compose.yml).
FROM golang:1.26-alpine@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c AS build
WORKDIR /src
COPY apps/server/go.mod apps/server/go.sum* ./
RUN go mod download
COPY apps/server/ ./
RUN CGO_ENABLED=0 go build -trimpath -tags nodynamic -ldflags="-s -w" -o /out/server ./cmd/server \
 && mkdir -p /out/data/files

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/server /server
# STORAGE_PATH=/data/files (ADR-0011). Owned by nonroot (65532) so a fresh named volume
# mounted here inherits writable ownership.
COPY --from=build --chown=65532:65532 /out/data /data
ENV STORAGE_DRIVER=fs STORAGE_PATH=/data/files
ENTRYPOINT ["/server"]
