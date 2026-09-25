#!/bin/sh
# Builds space-separated host lists from DOMAIN (primary), DOMAIN_ALT (alias, optional) and
# DOMAIN_LEGACY (temporary, optional) for the Caddyfile. Caddy substitutes {$VAR} before
# parsing, so a list expands into several site addresses / SNI values; empty vars are skipped.
set -eu
: "${DOMAIN:?DOMAIN is required}"
APP_HOSTS="" RTC_HOSTS="" TURN_HOSTS=""
for d in "$DOMAIN" "${DOMAIN_ALT:-}" "${DOMAIN_LEGACY:-}"; do
	[ -n "$d" ] || continue
	APP_HOSTS="$APP_HOSTS app.$d"
	RTC_HOSTS="$RTC_HOSTS rtc.$d"
	TURN_HOSTS="$TURN_HOSTS turn.$d"
done
export APP_HOSTS RTC_HOSTS TURN_HOSTS
exec "$@"
