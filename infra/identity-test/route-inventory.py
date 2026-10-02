#!/usr/bin/env python3
"""Maintain the baseline route census; this is an audit helper, not an auth gate."""
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[2]
target = root / "docs/plans/identity-v2-route-inventory.md"
pattern = re.compile(r'"((?:(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /[^"\n]+)|/api/)"')
bot_source = (root / "apps/server/internal/app/botroutes.go").read_text()
bot_map = bot_source.split("var botRoutes =", 1)[1].split("\n}", 1)[0]
bots = dict(re.findall(r'^\s*"([^"]+)":\s*bot(Public|Allow|Deny)', bot_map, re.M))
locations = {}
for path in sorted((root / "apps/server/internal").rglob("*.go")):
    if path.name.endswith("_test.go") or path.name == "botroutes.go":
        continue
    for number, line in enumerate(path.read_text().splitlines(), 1):
        for route in pattern.findall(line):
            locations.setdefault(route, []).append(f"{path.relative_to(root)}:{number}")
if set(locations) != set(bots):
    sys.exit(f"Route census mismatch: missing bot decision={sorted(set(locations)-set(bots))}; "
             f"missing source={sorted(set(bots)-set(locations))}")


def classify(route):
    method, _, url = route.partition(" ")
    if route == "/api/" or url in ("/healthz", "/readyz", "/metrics", "/api/version"):
        return "public", "P0"
    if url == "/gateway":
        return "gateway", "GW"
    if url == "/api/rtc/webhook":
        return "signed-SFU", "RTC"
    if url == "/api/auth/logout":
        return "own-session", "G1"
    if url in ("/api/auth/login", "/api/auth/register", "/api/auth/password/forgot", "/api/auth/password/reset"):
        return "local-proof", "G0"
    if url == "/api/auth/refresh":
        return "own-session", "G1"
    if url.startswith(("/api/invites/", "/api/room-invites/", "/api/event-rsvp")):
        return "capability-target", "C0"
    if url.startswith("/api/admin/"):
        return "global-admin", "G0"
    if url in ("/api/me", "/api/me/mentions", "/api/me/events/today", "/api/me/sticker-packs") and method == "GET":
        return "aggregate-profile" if url == "/api/me" else "aggregate", "A0"
    if url == "/api/workspaces" and method == "GET":
        return "aggregate", "A0"
    if url == "/api/workspaces/discover":
        return "aggregate", "A0"
    if url == "/api/workspaces" or url.startswith(("/api/me/", "/api/users/", "/api/auth/verify")) or url == "/api/me":
        return "global-account", "G0"
    if url.startswith("/api/workspaces/"):
        return "workspace-id", "W0"
    if url.startswith("/api/files/"):
        return "file-id", "F0"
    if url.startswith(("/api/dms", "/api/notes", "/api/calls")):
        return "personal-resource", "G0+M0"
    if url.startswith("/api/unfurl"):
        return "external-or-resource", "R0"
    if url.startswith("/api/voice/"):
        return "active-voice-target", "RTC"
    if url.startswith(("/api/rooms/", "/api/messages/", "/api/categories/", "/api/boards/", "/api/tasks/",
                       "/api/t/", "/api/events/", "/api/workspace-apps/", "/api/sticker-packs/", "/api/stickers/", "/api/bots/")):
        return "resource-id", "R0"
    raise ValueError(f"Unclassified route: {route}")


lines = [f"Baseline census: **{len(bots)} unique patterns**, each with source, proposed gate class and proof ID.", "",
         "| Pattern | Registration source | Baseline bot decision | Planned identity gate | Proof |",
         "|---|---|---|---|---|"]
for route in sorted(bots):
    gate, proof = classify(route)
    source = locations[route][0]
    lines.append(f"| `{route}` | `{source}` | {bots[route].lower()} | {gate} | {proof} |")
block = "\n".join(lines)
begin, end = "<!-- ROUTES-BEGIN -->", "<!-- ROUTES-END -->"
document = target.read_text()
updated = document.split(begin)[0] + begin + "\n" + block + "\n" + end + document.split(end)[1]
if "--write" in sys.argv:
    target.write_text(updated)
elif document != updated:
    sys.exit("Route inventory drift; review changed classifications then run route-inventory.py --write")
print(f"PASS {len(bots)} unique routes: registered literal census = bot table = classified inventory")
