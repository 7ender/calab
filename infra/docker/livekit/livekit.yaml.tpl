# LiveKit self-hosted config TEMPLATE. See docs/03-network.md.
# Rendered by infra/docker/deploy.sh via envsubst into livekit.gen.yaml (gitignored).
# Only the DOMAIN and LIVEKIT_API_KEY variables are substituted; do not add other variables.
# API keys/secrets come from env LIVEKIT_KEYS (compose.yml), never from this file.
port: 7880
bind_addresses:
  - "127.0.0.1"          # affects only the signal HTTP listener (behind Caddy); media ports below are public

rtc:
  tcp_port: 7881
  udp_port: 7882          # UDP mux: all media on a single port
  use_external_ip: true
  allow_tcp_fallback: true
  # Don't advertise docker bridge addresses (docker0 / compose networks, 172.16.0.0/12)
  # as ICE candidates: host network makes LiveKit see them, but clients can't reach them.
  ips:
    excludes:
      - 172.16.0.0/12
  # on bad UDP the SDK falls back to TCP / TURN by itself

# Single node for MVP. Enable when adding a 2nd node; use db 1 (db 0 belongs to the API):
# redis:
#   address: 127.0.0.1:6379
#   db: 1

turn:
  enabled: true
  domain: turn.${DOMAIN}
  tls_port: 5349          # plain TURN behind Caddy layer4 (Caddy terminates TLS on :443, SNI turn.*)
  external_tls: true      # TLS for TURN is terminated by Caddy; no cert files here
  udp_port: 443           # TURN/UDP on 443 — passes where UDP is allowed only on 443
  # Relay sockets live BELOW the kernel ephemeral range (32768–60999), so the host firewall can
  # filter relayed traffic by source port without touching other processes' UDP (see docs/03,
  # "TURN relay"): no relaying to loopback/private networks, only to the SFU on :7882.
  relay_range_start: 20000
  relay_range_end: 29999

room:
  # Rooms are created only by our API: it calls CreateRoom (idempotent)
  # before issuing every join token.
  auto_create: false
  empty_timeout: 300
  max_participants: 100

audio:
  active_level: 30
  min_percentile: 40
  update_interval: 400
  smooth_intervals: 2

webhook:
  api_key: ${LIVEKIT_API_KEY}
  urls:
    - http://127.0.0.1:3000/api/rtc/webhook

prometheus:
  port: 6789              # 127.0.0.1 only (bind_addresses); scrape: see docs/06-deployment.md

logging:
  level: info
  json: true
