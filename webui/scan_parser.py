from __future__ import annotations

import re
from typing import Any

_DISC_LINE_RE = re.compile(
    r"^(System device|Device model|Offset|Overread|Overread mode|Speed|C2 errors|Paranoia level|Frame retries|HDCD decoding|Album Art|Outputs|Disc number|Total discs|Disc tracks|Tracks to rip|DiscID|Release ID|CDDB ID|Disc MCN|Album|Album artist|AccurateRip|Total time):\s+(.*)$"
)
_TRACK_INFO_RE = re.compile(r"^Track\s+(\d+)\s+info:$")
_TRACK_DONE_RE = re.compile(r"^Track\s+(\d+)\s+ripped and encoded successfully!$")
_METADATA_LINE_RE = re.compile(r"^([A-Za-z0-9_]+):\s+(.*)$")
_DURATION_RE = re.compile(r"^Duration:\s+(.+)$")
_EAC_RE = re.compile(r"^EAC CRC32:\s+([0-9A-F]+)", re.IGNORECASE)
_ACCURIP_BASE_RE = re.compile(r"^Acc(?:u|urate)rip:\s+(.+?)(?:\s+\(max confidence:\s*(\d+)\))?$", re.IGNORECASE)
_ACCURIP_DETAIL_RE = re.compile(r"^Acc(?:u|urate)rip v[12]:\s+\S+(?:\s+\(([^)]*)\))?", re.IGNORECASE)
_ACCURIP_CONF_RE = re.compile(r"confidence[:\s]+(\d+)", re.IGNORECASE)


def parse_scan_output(raw_output: str) -> dict[str, Any]:
    disc: dict[str, str] = {}
    tracks: list[dict[str, Any]] = []
    tracks_by_number: dict[int, dict[str, Any]] = {}

    current_track: dict[str, Any] | None = None
    in_metadata = False

    def ensure_track(number: int) -> dict[str, Any]:
        if number in tracks_by_number:
            return tracks_by_number[number]

        row = {
            "number": number,
            "title": "",
            "artist": "",
            "duration": "",
            "status": "detected",
            "progress": 0.0,
            "accurip": "",
            "accurip_text": "",
            "accurip_confidence": None,
            "accurip_max_confidence": None,
            "eac_crc": "",
            "metadata": {},
        }
        tracks_by_number[number] = row
        tracks.append(row)
        return row

    for raw_line in raw_output.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            in_metadata = False
            continue

        disc_match = _DISC_LINE_RE.match(stripped)
        if disc_match:
            key = disc_match.group(1).lower().replace(" ", "_")
            disc[key] = disc_match.group(2).strip()
            continue

        track_info_match = _TRACK_INFO_RE.match(stripped)
        if track_info_match:
            track_no = int(track_info_match.group(1))
            current_track = ensure_track(track_no)
            current_track["status"] = "detected"
            in_metadata = False
            continue

        track_done_match = _TRACK_DONE_RE.match(stripped)
        if track_done_match:
            track_no = int(track_done_match.group(1))
            current_track = ensure_track(track_no)
            current_track["status"] = "done"
            current_track["progress"] = 100.0
            in_metadata = False
            continue

        if current_track is None:
            continue

        if stripped == "Metadata:":
            in_metadata = True
            continue

        if in_metadata:
            metadata_match = _METADATA_LINE_RE.match(stripped)
            if metadata_match:
                meta_key = metadata_match.group(1)
                meta_value = metadata_match.group(2).strip()
                current_track["metadata"][meta_key] = meta_value

                if meta_key == "title" and not current_track["title"]:
                    current_track["title"] = meta_value
                elif meta_key == "artist" and not current_track["artist"]:
                    current_track["artist"] = meta_value
                continue

            in_metadata = False

        duration_match = _DURATION_RE.match(stripped)
        if duration_match:
            current_track["duration"] = duration_match.group(1).strip()
            continue

        eac_match = _EAC_RE.match(stripped)
        if eac_match:
            current_track["eac_crc"] = eac_match.group(1).upper()
            continue

        accurip_base_match = _ACCURIP_BASE_RE.match(stripped)
        if accurip_base_match:
            current_track["accurip_text"] = accurip_base_match.group(1).strip()
            max_conf = accurip_base_match.group(2)
            if max_conf:
                current_track["accurip_max_confidence"] = int(max_conf)
                _reconcile_accurip_confidence(current_track)
            continue

        accurip_detail_match = _ACCURIP_DETAIL_RE.match(stripped)
        if accurip_detail_match:
            detail = (accurip_detail_match.group(1) or "").strip()
            if detail:
                current_track["accurip_text"] = detail
                conf_match = _ACCURIP_CONF_RE.search(detail)
                if conf_match:
                    current_track["accurip_confidence"] = int(conf_match.group(1))
                elif "full confidence" in detail.lower() and current_track["accurip_max_confidence"] is not None:
                    current_track["accurip_confidence"] = current_track["accurip_max_confidence"]
                _reconcile_accurip_confidence(current_track)
            continue

    tracks.sort(key=lambda item: int(item["number"]))

    for track in tracks:
        if not track["title"]:
            track["title"] = f"Track {int(track['number']):02d}"
        track["accurip"] = _format_accurip(track)

    return {
        "disc": disc,
        "tracks": tracks,
    }


def _format_accurip(track: dict[str, Any]) -> str:
    confidence = track.get("accurip_confidence")
    max_confidence = track.get("accurip_max_confidence")
    text = (track.get("accurip_text") or "").strip()

    if confidence is not None and (max_confidence is None or confidence > max_confidence):
        max_confidence = confidence

    if confidence is not None and max_confidence is not None:
        return f"{confidence}/{max_confidence}"
    if confidence is not None:
        return str(confidence)
    return text


def _reconcile_accurip_confidence(track: dict[str, Any]) -> None:
    confidence = track.get("accurip_confidence")
    max_confidence = track.get("accurip_max_confidence")
    if confidence is not None and (max_confidence is None or confidence > max_confidence):
        track["accurip_max_confidence"] = confidence
