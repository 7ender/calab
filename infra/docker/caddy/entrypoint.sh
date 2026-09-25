#!/bin/sh
# Builds space-separated host lists (<domain>, rtc.<domain>, turn.<domain>) from DOMAIN (primary), DOMAIN_ALT (alias, optional) and
# DOMAIN_LEGACY (temporary, optional) for the Caddyfile, plus RTC_ORIGINS for the web CSP. Caddy substitutes {$VAR} before
# parsing, so a list expands into several site addresses / SNI values; empty vars are skipped.
set -eu
: "${DOMAIN:?DOMAIN is required}"
APP_HOSTS="" RTC_HOSTS="" TURN_HOSTS="" RTC_ORIGINS=""
for d in "$DOMAIN" "${DOMAIN_ALT:-}" "${DOMAIN_LEGACY:-}"; do
	[ -n "$d" ] || continue
	APP_HOSTS="$APP_HOSTS $d"          # app (API, gateway, web) lives on the domain itself
	RTC_HOSTS="$RTC_HOSTS rtc.$d"
	TURN_HOSTS="$TURN_HOSTS turn.$d"
	# LiveKit signal origins for the web client CSP connect-src (wss signal + https /rtc/validate)
	RTC_ORIGINS="$RTC_ORIGINS wss://rtc.$d https://rtc.$d"
done
export APP_HOSTS RTC_HOSTS TURN_HOSTS RTC_ORIGINS
exec "$@"
