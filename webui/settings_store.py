from __future__ import annotations

import copy
import json
import threading
from pathlib import Path
from typing import Any

DEFAULT_SETTINGS: dict[str, Any] = {
    "binary_path": "./bin/cyanrip",
    "working_directory": "./output",
    "language": "en",
    "device_profiles": {},
    "misc_offset": 0,
}

SUPPORTED_LANGUAGES = {"en", "de"}


class SettingsStore:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.RLock()
        self._settings = self._load_from_disk()

    def read(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._settings)

    def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            merged = copy.deepcopy(self._settings)
            merged.update(patch or {})
            normalized = _normalize_settings(merged)
            self._settings = normalized
            self._save_to_disk(normalized)
            return copy.deepcopy(normalized)

    def get_device_offset(self, device_id: str) -> int | None:
        with self._lock:
            profiles = self._settings.get("device_profiles")
            if not isinstance(profiles, dict):
                return None
            profile = profiles.get(str(device_id))
            if not isinstance(profile, dict):
                return None
            value = profile.get("offset")
            if value is None:
                return None
            try:
                return int(str(value).strip())
            except (TypeError, ValueError):
                return None

    def update_device_offset(self, device_id: str, offset: int | None) -> dict[str, Any]:
        key = str(device_id).strip()
        if not key:
            return self.read()

        with self._lock:
            merged = copy.deepcopy(self._settings)
            profiles = merged.setdefault("device_profiles", {})
            if not isinstance(profiles, dict):
                profiles = {}
                merged["device_profiles"] = profiles

            if offset is None:
                profiles.pop(key, None)
            else:
                profiles[key] = {"offset": int(offset)}

            normalized = _normalize_settings(merged)
            self._settings = normalized
            self._save_to_disk(normalized)
            return copy.deepcopy(normalized)

    def _load_from_disk(self) -> dict[str, Any]:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if not self._path.exists():
            initial = _normalize_settings(DEFAULT_SETTINGS)
            self._save_to_disk(initial)
            return initial

        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = {}

        merged = copy.deepcopy(DEFAULT_SETTINGS)
        if isinstance(raw, dict):
            merged.update(raw)

        normalized = _normalize_settings(merged)
        self._save_to_disk(normalized)
        return normalized

    def _save_to_disk(self, payload: dict[str, Any]) -> None:
        temp_path = self._path.with_suffix(self._path.suffix + ".tmp")
        text = json.dumps(payload, indent=2, ensure_ascii=True, sort_keys=True)
        temp_path.write_text(text + "\n", encoding="utf-8")
        temp_path.replace(self._path)


def _normalize_settings(raw: dict[str, Any]) -> dict[str, Any]:
    normalized = copy.deepcopy(DEFAULT_SETTINGS)

    binary_path = str(raw.get("binary_path") or "").strip()
    normalized["binary_path"] = binary_path or DEFAULT_SETTINGS["binary_path"]

    working_directory = str(raw.get("working_directory") or "").strip()
    normalized["working_directory"] = working_directory or DEFAULT_SETTINGS["working_directory"]

    language = str(raw.get("language") or "").strip().lower()
    normalized["language"] = language if language in SUPPORTED_LANGUAGES else DEFAULT_SETTINGS["language"]

    misc_offset_raw = raw.get("misc_offset")
    try:
        normalized["misc_offset"] = int(str(misc_offset_raw).strip()) if misc_offset_raw is not None else 0
    except (TypeError, ValueError):
        normalized["misc_offset"] = 0

    profiles_out: dict[str, dict[str, int]] = {}
    profiles_raw = raw.get("device_profiles")
    if isinstance(profiles_raw, dict):
        for key, value in profiles_raw.items():
            profile_key = str(key).strip()
            if not profile_key or not isinstance(value, dict):
                continue

            if value.get("offset") is None:
                continue

            try:
                offset = int(str(value.get("offset")).strip())
            except (TypeError, ValueError):
                continue

            profiles_out[profile_key] = {"offset": offset}

    normalized["device_profiles"] = profiles_out
    return normalized
