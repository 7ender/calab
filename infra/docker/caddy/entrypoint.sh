#!/bin/sh
# Builds the host lists for the Caddyfile from the env (docs/10-branding.md, docs/06):
#   DOMAIN         primary domain: rtc.<DOMAIN>, turn.<DOMAIN> (LiveKit announces turn.<DOMAIN>)
#   APP_HOST       the app (web client, API, gateway, /download/); default: DOMAIN
#   LANDING_HOST   static landing (optional; empty = no landing site)
#   DOMAIN_ALT, DOMAIN_LEGACY  extra app hosts (transitional aliases, optional); their rtc./turn. names
#                  are served too so older clients keep working while they move over
# Caddy substitutes {$VAR} before parsing, so a list expands into several site addresses / SNI values.
# The landing site is generated into /tmp/landing.caddy (imported by the Caddyfile; empty when unset),
# because a site block with an empty address would not parse.
set -eu
: "${DOMAIN:?DOMAIN is required}"
APP_HOSTS="${APP_HOST:-$DOMAIN}" RTC_HOSTS="rtc.$DOMAIN" TURN_HOSTS="turn.$DOMAIN"
for h in "${DOMAIN_ALT:-}" "${DOMAIN_LEGACY:-}"; do
	[ -n "$h" ] || continue
	APP_HOSTS="$APP_HOSTS $h"
	RTC_HOSTS="$RTC_HOSTS rtc.$h"
	TURN_HOSTS="$TURN_HOSTS turn.$h"
done
# LiveKit signal origins for the web client CSP connect-src (wss signal + https /rtc/validate)
RTC_ORIGINS=""
for h in $RTC_HOSTS; do RTC_ORIGINS="$RTC_ORIGINS wss://$h https://$h"; done
if [ -n "${LANDING_HOST:-}" ]; then
	printf '%s {\n\timport landing_site\n}\n' "$LANDING_HOST" > /tmp/landing.caddy
else
	: > /tmp/landing.caddy
fi
export APP_HOSTS RTC_HOSTS TURN_HOSTS RTC_ORIGINS
exec "$@"
