#!/bin/sh
# Builds the host lists for the Caddyfile from the env (docs/10-branding.md, docs/06):
#   DOMAIN         primary domain: rtc.<DOMAIN>, turn.<DOMAIN> (LiveKit announces turn.<DOMAIN>)
#   APP_HOST       the app (web client, API, gateway, /download/); default: DOMAIN
#   LANDING_HOST   static landing (optional; empty = no landing site)
#   DOMAIN_ALT, DOMAIN_LEGACY  extra app hosts (aliases, optional; e.g. meet.gptunnel.ru). Only the app is
#                  served there: clients get the rtc./turn. URLs of DOMAIN from the API
#   RELEASES_HOST  desktop release feed (optional; empty = none): reverse proxy to a public-read S3 bucket
#                  when S3_PUBLIC_URL is set (the bucket's public base URL, e.g. Yandex Object Storage
#                  https://storage.yandexcloud.net/<bucket> — path-style — or a virtual-hosted URL without a
#                  path), else /srv/releases. With it set, /download/* on the app and landing hosts redirects
#                  there (302, same path).
# Caddy substitutes {$VAR} before parsing, so a list expands into several site addresses / SNI values.
# The landing site is generated into /tmp/landing.caddy (imported by the Caddyfile; empty when unset),
# because a site block with an empty address would not parse.
set -eu
: "${DOMAIN:?DOMAIN is required}"
APP_HOSTS="${APP_HOST:-$DOMAIN}" RTC_HOSTS="rtc.$DOMAIN" TURN_HOSTS="turn.$DOMAIN"
for h in "${DOMAIN_ALT:-}" "${DOMAIN_LEGACY:-}"; do
	[ -n "$h" ] || continue
	APP_HOSTS="$APP_HOSTS $h"
done
# LiveKit signal origins for the web client CSP connect-src (wss signal + https /rtc/validate)
RTC_ORIGINS=""
for h in $RTC_HOSTS; do RTC_ORIGINS="$RTC_ORIGINS wss://$h https://$h"; done
if [ -n "${LANDING_HOST:-}" ]; then
	printf '%s {\n\timport landing_site\n}\n' "$LANDING_HOST" > /tmp/landing.caddy
else
	: > /tmp/landing.caddy
fi

# /download/ on app + landing: redirect to the release host, or serve /srv/releases locally.
if [ -n "${RELEASES_HOST:-}" ]; then
	printf '@dl path_regexp dl ^/download/(.*)$\nredir @dl https://%s/{re.dl.1} 302\n' "$RELEASES_HOST" > /tmp/download.caddy
else
	printf 'handle_path /download/* {\n\timport releases_files\n}\n' > /tmp/download.caddy
fi

# The release host itself.
if [ -z "${RELEASES_HOST:-}" ]; then
	: > /tmp/releases.caddy
elif [ -n "${S3_PUBLIC_URL:-}" ]; then
	# https://host[/prefix] → upstream https://host, keys under /prefix; S3 sees its own Host header
	S3_UPSTREAM="$(printf '%s' "$S3_PUBLIC_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
	S3_PREFIX="$(printf '%s' "$S3_PUBLIC_URL" | sed -E 's#^https?://[^/]+##; s#/+$##')"
	cat > /tmp/releases.caddy <<EOF_S3
$RELEASES_HOST {
	import releases_host_headers
	# (several rewrites in one block are mutually exclusive in Caddy — hence a separate handle for /)
	handle / {
		rewrite * $S3_PREFIX/index.html
		reverse_proxy $S3_UPSTREAM {
			header_up Host {upstream_hostport}
			header_down Cache-Control "no-cache"
		}
	}
	@meta path /index.html *.yml *.yaml
	handle @meta {
		rewrite * $S3_PREFIX{uri}
		reverse_proxy $S3_UPSTREAM {
			header_up Host {upstream_hostport}
			header_down Cache-Control "no-cache"
		}
	}
	handle {
		rewrite * $S3_PREFIX{uri}
		reverse_proxy $S3_UPSTREAM {
			header_up Host {upstream_hostport}
			header_down Cache-Control "public, max-age=31536000, immutable"
		}
	}
}
EOF_S3
else
	printf '%s {\n\timport releases_host_headers\n\timport releases_files\n}\n' "$RELEASES_HOST" > /tmp/releases.caddy
fi

export APP_HOSTS RTC_HOSTS TURN_HOSTS RTC_ORIGINS
exec "$@"
