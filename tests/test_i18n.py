import json
import re
import unittest
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
I18N_DIR = ROOT / "webui" / "static" / "i18n"


def _load_locale(name: str) -> dict[str, Any]:
    with (I18N_DIR / f"{name}.json").open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise AssertionError(f"{name}.json must contain an object")
    return payload


def _flatten(payload: dict[str, Any], prefix: str = "") -> set[str]:
    keys: set[str] = set()
    for key, value in payload.items():
        dotted = f"{prefix}.{key}" if prefix else str(key)
        if isinstance(value, dict):
            keys.update(_flatten(value, dotted))
        else:
            keys.add(dotted)
    return keys


class I18nTests(unittest.TestCase):
    def test_english_and_german_key_sets_match(self) -> None:
        en_keys = _flatten(_load_locale("en"))
        de_keys = _flatten(_load_locale("de"))
        self.assertEqual(en_keys - de_keys, set(), "Missing German i18n keys")
        self.assertEqual(de_keys - en_keys, set(), "Missing English i18n keys")

    def test_referenced_i18n_keys_exist_in_all_locales(self) -> None:
        files = [
            ROOT / "webui" / "templates" / "index.html",
            ROOT / "webui" / "static" / "app.js",
            ROOT / "webui" / "app_factory.py",
        ]
        referenced: set[str] = set()
        for path in files:
            text = path.read_text(encoding="utf-8")
            referenced.update(re.findall(r'data-(?:i18n(?:-[a-z]+)?|tip-key)="([^"]+)"', text))
            referenced.update(re.findall(r'\bt\(\s*"([^"]+)"', text))
            referenced.update(re.findall(r'\blocalizedError\(\s*"([^"]+)"', text))
            referenced.update(re.findall(r'error_key["\']?(?:\])?\s*[:=]\s*["\']([^"\']+)["\']', text))

        for locale in ("en", "de"):
            keys = _flatten(_load_locale(locale))
            missing = sorted(key for key in referenced if key not in keys)
            self.assertEqual(missing, [], f"Missing referenced i18n keys in {locale}.json")


if __name__ == "__main__":
    unittest.main()
