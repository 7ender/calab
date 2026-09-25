# Caddy with the layer4 app (SNI routing of TURN/TLS on :443). See docs/03-network.md, ADR-0006.
FROM caddy:2-builder AS build
# Pinned: v0.1.2 (commit 42db569). Bump deliberately — caddy-l4 warns about breaking changes.
RUN xcaddy build --with github.com/mholt/caddy-l4@v0.1.2

FROM caddy:2
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
