"""CHANGELOG → chat message formatting of tools/release-announce.py.

    python3 -m unittest tools/release_announce_test.py
"""
import importlib.util
import os
import unittest

_spec = importlib.util.spec_from_file_location(
    "release_announce", os.path.join(os.path.dirname(os.path.abspath(__file__)), "release-announce.py"))
ra = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ra)

CHANGELOG = """# Изменения

## [Unreleased]

### Добавлено
- **Не выпущено**: не должно попасть.

## [1.2.3] — 2026-09-28

### Исправлено
- **Звук**: не пропадает после сна (#90).

### Обновление
- Миграция 00040 выполняется автоматически.

### Добавлено
- **Бейджи**: картинки рядом с именем (#82). Миграция 00035.
- **Пересылка** (ADR-0033, #81): в личные и комнаты,
  несколько получателей сразу.

### Изменено
- **Стикеры**: эмодзи из общего пикера (#79).

## [1.2.2] — 2026-09-20

### Добавлено
- **Старое**: не должно попасть.

[1.2.3]: https://example.test
"""


class RenderTest(unittest.TestCase):
    def test_message(self):
        self.assertEqual(ra.render("1.2.3", CHANGELOG), "\n\n".join([
            "🚀 **Calab 1.2.3** — 28 сентября 2026",
            "✨ **Добавлено**\n• **Бейджи**: картинки рядом с именем.\n"
            "• **Пересылка**: в личные и комнаты, несколько получателей сразу.",
            "🔧 **Изменено**\n• **Стикеры**: эмодзи из общего пикера.",
            "🐞 **Исправлено**\n• **Звук**: не пропадает после сна.",
            "Обновление придёт само",
        ]))

    def test_missing_version(self):
        with self.assertRaises(ra.AnnounceError):
            ra.render("9.9.9", CHANGELOG)

    def test_clean_bullet(self):
        self.assertEqual(ra.clean_bullet("**A**: b (ADR-0034, #85). Миграции 00034 и 00035."), "**A**: b.")
        self.assertEqual(ra.clean_bullet("**A**: see (например, это) (#1)"), "**A**: see (например, это)")

    def test_limit_keeps_whole_bullets(self):
        bullets = "\n".join(f"- **Пункт {i}**: " + "х" * 300 for i in range(30))
        msg = ra.render("2.0.0", f"## [2.0.0] — 2026-10-01\n\n### Добавлено\n{bullets}\n")
        self.assertLessEqual(len(msg), ra.MAX_CONTENT)
        self.assertIn(ra.TRUNCATED, msg)
        self.assertTrue(msg.endswith("Обновление придёт само"))
        for line in msg.split("\n"):
            if line.startswith("• "):
                self.assertTrue(line.endswith("х" * 300))  # never cut mid-bullet


if __name__ == "__main__":
    unittest.main()
