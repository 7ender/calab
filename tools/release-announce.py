#!/usr/bin/env python3
"""Post the release notes of one version into the team's «what's new» room as a bot.

    tools/release-announce.py <version> [--dry-run] [--changelog CHANGELOG.md]

Env:
  CALAB_RELEASE_BOT_TOKEN  bot token (required unless --dry-run); sent only as `Authorization: Bearer`
  CALAB_API_URL            default https://app.calab.ru
  CALAB_RELEASE_ROOM       default «Calab - что нового? ✨» (exact room name)

Reads the `## [<version>]` section of CHANGELOG.md and renders it with the chat's markdown-lite
(apps/desktop/src/renderer/lib/markdown: bold, links, line breaks — no lists or headings, so bullets
are «• » lines). The post uses nonce `release-<version>`: the server dedups by (author, nonce)
(docs/04 «Сообщения: порядок и идемпотентность»), so a re-run never double-posts.
Called by the `announce` step of infra/docker/release.sh. Python 3 stdlib only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_CONTENT = 4000  # runes; apps/server/internal/messages MaxContent
DEFAULT_API = "https://app.calab.ru"
DEFAULT_ROOM = "Calab - что нового? ✨"

# Section order and emoji; «Обновление» (operator notes: migrations, env) is never posted.
SECTIONS = [("Добавлено", "✨"), ("Изменено", "🔧"), ("Исправлено", "🐞"),
            ("Удалено", "🧹"), ("Безопасность", "🔒")]
SKIP = {"Обновление"}
OTHER_EMOJI = "📌"
MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
          "сентября", "октября", "ноября", "декабря"]
TRUNCATED = "…полный список — по ссылке"

# A parenthetical made only of references: (#82), (ADR-0033, #81), (ADR-0034)
REF_PAREN = re.compile(r"\s*\((?:\s*(?:#\d+|ADR-\d+)\s*[,;]?)+\)")
# «Миграция 00035.» / «Миграции 00034, 00035.» tails
MIGRATION = re.compile(r"\s*Миграци[яи]\s+\d{3,}(?:\s*(?:,|и)\s*\d{3,})*\.?")


class AnnounceError(Exception):
    pass


def changelog_section(text: str, version: str) -> tuple[str, list[str]]:
    """The date from the heading and the body lines of `## [<version>]`."""
    head = f"## [{version}]"
    lines = text.replace("\r\n", "\n").split("\n")
    for i, line in enumerate(lines):
        if line.startswith(head):
            m = re.search(r"(\d{4})-(\d{2})-(\d{2})", line[len(head):])
            date = f"{int(m.group(3))} {MONTHS[int(m.group(2)) - 1]} {m.group(1)}" if m else ""
            body = []
            for nxt in lines[i + 1:]:
                if nxt.startswith("## [") or re.match(r"^\[[^\]]+\]: ", nxt):
                    break
                body.append(nxt)
            return date, body
    raise AnnounceError(f"no section [{version}] in CHANGELOG.md")


def parse_sections(body: list[str]) -> list[tuple[str, list[str]]]:
    """[(title, [bullet text])] in file order; continuation lines are joined into their bullet."""
    out: list[tuple[str, list[str]]] = []
    for line in body:
        if line.startswith("### "):
            out.append((line[4:].strip(), []))
        elif not out:
            continue
        elif re.match(r"^[-*] ", line):
            out[-1][1].append(line[2:].strip())
        elif line.strip() and out[-1][1] and line[:1] in (" ", "\t"):
            out[-1][1][-1] += " " + line.strip()
    return out


def clean_bullet(s: str) -> str:
    s = MIGRATION.sub("", s)
    s = REF_PAREN.sub("", s)
    s = re.sub(r"\s+([.,;:])", r"\1", s).strip()
    return re.sub(r"\s{2,}", " ", s)


def render(version: str, changelog: str) -> str:
    date, body = changelog_section(changelog, version)
    parsed = [(t, [clean_bullet(b) for b in bs if b.strip()]) for t, bs in parse_sections(body)
              if t not in SKIP]
    order = {t: i for i, (t, _) in enumerate(SECTIONS)}
    parsed.sort(key=lambda s: order.get(s[0], len(SECTIONS)))  # stable: unknown ones keep file order
    emoji = dict(SECTIONS)
    parsed = [(t, bs) for t, bs in parsed if bs]
    if not parsed:
        raise AnnounceError(f"section [{version}] has nothing to announce")

    header = f"🚀 **Calab {version}**" + (f" — {date}" if date else "")
    footer = "Обновление придёт само"

    def build(limit: int | None) -> str:
        parts, n = [header], 0
        for title, bullets in parsed:
            if limit is not None and n >= limit:
                break
            take = bullets if limit is None else bullets[:limit - n]
            n += len(take)
            parts.append(f"{emoji.get(title, OTHER_EMOJI)} **{title}**\n" + "\n".join(f"• {b}" for b in take))
        if limit is not None:
            parts.append(TRUNCATED)
        parts.append(footer)
        return "\n\n".join(parts)

    msg = build(None)
    total = sum(len(bs) for _, bs in parsed)
    limit = total
    while len(msg) > MAX_CONTENT:
        limit -= 1
        if limit < 0:
            raise AnnounceError("message does not fit even without bullets")
        msg = build(limit)
    return msg


# --- API ---------------------------------------------------------------------------------------

class Api:
    def __init__(self, base: str, token: str):
        self.base, self.token = base.rstrip("/"), token

    def call(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read() or b"{}")
            except ValueError:
                err = {}
            code = err.get("code", "?")
            reason = f", reason {err['reason']}" if err.get("reason") else ""
            raise AnnounceError(f"{method} {path} → HTTP {e.code} ({code}{reason})") from None
        except urllib.error.URLError as e:
            raise AnnounceError(f"{method} {path} → {e.reason}") from None


def find_room(api: Api, name: str) -> tuple[str, str]:
    """(room id, workspace name) of the room with exactly this name among the bot's workspaces."""
    _, me = api.call("GET", "/api/bots/me")
    bot = me.get("bot", {})
    _, wss = api.call("GET", "/api/workspaces")
    workspaces = wss.get("workspaces", [])
    found = []
    for ws in workspaces:
        _, rooms = api.call("GET", f"/api/workspaces/{urllib.parse.quote(ws['id'])}/rooms")
        found += [(r["id"], ws.get("name", ws["id"])) for r in rooms.get("rooms", []) if r.get("name") == name]
    who = bot.get("username") or bot.get("user", {}).get("displayName", "bot")
    if not found:
        raise AnnounceError(
            f"bot @{who} sees no room named «{name}» in its {len(workspaces)} workspace(s): an admin must add "
            "the bot to that workspace and give it VIEW_ROOM + SEND_MESSAGES in the room")
    if len(found) > 1:
        raise AnnounceError(f"{len(found)} rooms named «{name}» are visible to @{who}; set CALAB_RELEASE_ROOM")
    return found[0]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("version")
    ap.add_argument("--dry-run", action="store_true", help="print the message, post nothing")
    ap.add_argument("--changelog", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "CHANGELOG.md"))
    a = ap.parse_args(argv)
    version = a.version.removeprefix("v")
    try:
        with open(a.changelog, encoding="utf-8") as f:
            msg = render(version, f.read())
        if a.dry_run:
            print(msg)
            print(f"\n-- {len(msg)} chars, dry run: nothing posted", file=sys.stderr)
            return 0
        token = os.environ.get("CALAB_RELEASE_BOT_TOKEN", "").strip()
        if not token:
            raise AnnounceError("CALAB_RELEASE_BOT_TOKEN is not set")
        api = Api(os.environ.get("CALAB_API_URL") or DEFAULT_API, token)
        room = os.environ.get("CALAB_RELEASE_ROOM") or DEFAULT_ROOM
        room_id, ws_name = find_room(api, room)
        status, res = api.call("POST", f"/api/rooms/{urllib.parse.quote(room_id)}/messages",
                               {"content": msg, "nonce": f"release-{version}"})
        mid = res.get("message", {}).get("id", "?")
        state = "posted" if status == 201 else "already posted earlier (same nonce), nothing new"
        print(f"release-announce: {version} {state}: message {mid} in «{room}» ({ws_name})")
        return 0
    except (AnnounceError, OSError) as e:
        print(f"release-announce: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
