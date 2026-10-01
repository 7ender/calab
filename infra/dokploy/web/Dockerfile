# ==============================================================
# Calab web image
#
# Builds:
#   1. Desktop SPA
#      apps/desktop -> dist-web
#
#   2. Landing
#      apps/landing -> out
#
# nginx then serves both.
#
# Build context:
#   repository root
# ==============================================================


# ==============================================================
# BUILD
# ==============================================================

FROM node:24-slim AS build

RUN corepack enable

WORKDIR /repo

COPY . .


# Native Electron/uiohook binaries are not required by the
# browser build.
RUN pnpm install --frozen-lockfile --ignore-scripts


# --------------------------------------------------------------
# Desktop web client
# --------------------------------------------------------------

RUN pnpm -F @calaba/desktop build:web


# --------------------------------------------------------------
# Landing
#
# apps/landing uses Next.js static export:
#
#   output: "export"
#   trailingSlash: true
#
# Output:
#   apps/landing/out
# --------------------------------------------------------------

RUN pnpm -F @calaba/landing build


# --------------------------------------------------------------
# Local releases directory.
#
# The actual release artifacts are normally supplied by:
#
#   S3_PUBLIC_URL
#
# or manually into the Dokploy releases_data volume.
#
# We create the directory so the runtime image always contains
# the expected path.
# --------------------------------------------------------------

RUN mkdir -p /repo/releases


# ==============================================================
# RUNTIME
# ==============================================================

FROM nginx:alpine

# The official nginx image processes *.template at container
# startup using envsubst.
#
# We deliberately keep nginx variables such as:
#
#   $uri
#   $request_uri
#   $http_user_agent
#   $calab_cache_control
#
# untouched by limiting envsubst to the variables we explicitly
# provide through the container environment.

COPY infra/dokploy/web/default.conf.template \
  /etc/nginx/templates/default.conf.template


# --------------------------------------------------------------
# Desktop SPA
# --------------------------------------------------------------

COPY --from=build \
  /repo/apps/desktop/dist-web \
  /usr/share/nginx/html


# --------------------------------------------------------------
# Landing
# --------------------------------------------------------------

COPY --from=build \
  /repo/apps/landing/out \
  /srv/landing


# --------------------------------------------------------------
# Local release directory
# --------------------------------------------------------------

COPY --from=build \
  /repo/releases \
  /srv/releases
