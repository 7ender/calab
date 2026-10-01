# Production web image: Caddy plus the static web client and landing of one release, nothing else.
# Built by .github/workflows/images.yml from a context with two directories:
#   web/      apps/desktop/dist-web (pnpm -F @calaba/desktop build:web, source maps removed)
#   landing/  apps/landing/out      (pnpm -F @calaba/landing build)
# The server configuration (Caddyfile, site lists, entrypoint) is not part of the image: the deployment
# supplies it, so this image only carries content and can be swapped by digest.
FROM caddy:2.11.4@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52
# Copying the binary drops its file capability (cap_net_bind_service): Caddy listens on a high port and
# must start in a container with every capability dropped and no privilege escalation.
RUN cp /usr/bin/caddy /usr/bin/caddy.nocap && mv /usr/bin/caddy.nocap /usr/bin/caddy \
 && rm -f /etc/caddy/Caddyfile && mkdir -p /srv/releases
COPY web /srv/web
COPY landing /srv/landing
ENV XDG_DATA_HOME=/tmp/caddy/data XDG_CONFIG_HOME=/tmp/caddy/config
USER 65532:65532
