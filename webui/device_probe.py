from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def list_optical_drives(device_profiles: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    profile_map = device_profiles if isinstance(device_profiles, dict) else {}

    candidates: dict[str, dict[str, Any]] = {}

    by_id_dir = Path("/dev/disk/by-id")
    if by_id_dir.is_dir():
        for entry in sorted(by_id_dir.iterdir(), key=lambda item: item.name):
            if not entry.is_symlink():
                continue

            name_lower = entry.name.lower()
            if not any(token in name_lower for token in ("cd", "dvd", "bd", "sr")):
                continue

            resolved = _safe_resolve(entry)
            if resolved is None:
                continue

            if not _looks_like_optical_device(resolved):
                continue

            key = str(resolved)
            record = candidates.get(key)
            if record is None:
                record = _build_drive_record(device_id=f"by-id:{entry.name}", device_path=resolved)
                candidates[key] = record
            else:
                # Prefer by-id stable identifiers over fallback IDs.
                record["id"] = f"by-id:{entry.name}"

    sys_block = Path("/sys/block")
    if sys_block.is_dir():
        for entry in sorted(sys_block.iterdir(), key=lambda item: item.name):
            if not entry.name.startswith("sr"):
                continue

            device_path = Path("/dev") / entry.name
            key = str(device_path)
            if key in candidates:
                continue

            record = _build_drive_record(device_id=f"sys:{entry.name}", device_path=device_path)
            candidates[key] = record

    for record in candidates.values():
        profile = profile_map.get(record["id"])
        if isinstance(profile, dict) and profile.get("offset") is not None:
            try:
                record["saved_offset"] = int(str(profile.get("offset")).strip())
            except (TypeError, ValueError):
                record["saved_offset"] = None
        else:
            record["saved_offset"] = None

    return sorted(candidates.values(), key=lambda item: (item.get("name") or "", item.get("path") or ""))


def _build_drive_record(device_id: str, device_path: Path) -> dict[str, Any]:
    path = str(device_path)
    name = device_path.name

    vendor = _read_first_line(Path("/sys/block") / name / "device" / "vendor")
    model = _read_first_line(Path("/sys/block") / name / "device" / "model")

    label_parts = [part for part in (vendor, model) if part]
    label = " ".join(label_parts).strip() if label_parts else name

    return {
        "id": str(device_id),
        "path": path,
        "name": name,
        "label": label,
        "vendor": vendor,
        "model": model,
    }


def _safe_resolve(path: Path) -> Path | None:
    try:
        return path.resolve(strict=True)
    except OSError:
        return None


def _looks_like_optical_device(path: Path) -> bool:
    if not path.exists():
        return False

    name = path.name
    if name.startswith("sr"):
        return True

    # Accept device-mapper paths that still point to srN nodes.
    try:
        real_name = os.path.realpath(str(path)).split("/")[-1]
    except OSError:
        return False
    return real_name.startswith("sr")


def _read_first_line(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore").splitlines()[0].strip()
    except (OSError, IndexError):
        return ""
