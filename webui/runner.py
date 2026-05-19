from __future__ import annotations

import copy
import os
import re
import subprocess
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any


_DISC_TRACKS_RE = re.compile(r"^Disc\s+tracks:\s+(\d+)$", re.IGNORECASE)
_TRACKS_TO_RIP_RE = re.compile(r"^Tracks\s+to\s+rip:\s+(.+)$", re.IGNORECASE)
_TRACK_INFO_RE = re.compile(r"^Track\s+(\d+)\s+info:", re.IGNORECASE)
_TRACK_DONE_RE = re.compile(r"^Track\s+(\d+)\s+ripped and encoded successfully!$", re.IGNORECASE)
_PROGRESS_RE = re.compile(
    r"^Ripping(?:\s+and\s+encoding)?\s+track\s+(\d+),\s+progress\s+-\s+([0-9]+(?:\.[0-9]+)?)%",
    re.IGNORECASE,
)
_ETA_RE = re.compile(r",\s+ETA\s+-\s+(.+?)(?:,\s+errors\s+-\s+\d+)?$", re.IGNORECASE)
_DURATION_RE = re.compile(r"^Duration:\s+(.+)$", re.IGNORECASE)
_TITLE_RE = re.compile(r"^title:\s+(.+)$", re.IGNORECASE)
_ARTIST_RE = re.compile(r"^artist:\s+(.+)$", re.IGNORECASE)
_ACCURIP_RE = re.compile(r"^Acc(?:u|urate)rip:\s+(.+?)(?:\s+\(max\s+confidence:\s*(\d+)\))?$", re.IGNORECASE)
_ACCURIP_DETAIL_RE = re.compile(r"^Acc(?:u|urate)rip\s+v[12]:\s+\S+(?:\s+\(([^)]*)\))?", re.IGNORECASE)
_ACCURIP_CONF_RE = re.compile(r"confidence[:\s]+(\d+)", re.IGNORECASE)


@dataclass(slots=True)
class LogLine:
    index: int
    line: str


class CyanripJobRunner:
    def __init__(self, max_log_lines: int = 4000) -> None:
        self._lock = threading.RLock()
        self._max_log_lines = max_log_lines

        self._state = "idle"
        self._job_id: str | None = None
        self._command: list[str] = []
        self._shell_command = ""
        self._working_directory: str | None = None
        self._started_at: float | None = None
        self._finished_at: float | None = None
        self._returncode: int | None = None

        self._process: subprocess.Popen[str] | None = None
        self._reader_thread: threading.Thread | None = None
        self._stop_requested = False

        self._next_log_index = 0
        self._logs: deque[LogLine] = deque(maxlen=max_log_lines)

        self._scan_last_success = False
        self._scan_last_returncode: int | None = None
        self._scan_last_error: str | None = None
        self._scan_updated_at: float | None = None

        self._disc_info: dict[str, Any] = {}
        self._disc_tracks: list[dict[str, Any]] = []

        self._rip_tracks: dict[int, dict[str, Any]] = {}
        self._active_track_no: int | None = None
        self._rip_meta_disc_tracks: int | None = None
        self._rip_meta_planned_track_numbers: list[int] | None = None
        self._rip_meta_total_tracks = 0
        self._rip_meta_current_track_no: int | None = None
        self._rip_meta_current_track_progress = 0.0
        self._rip_meta_eta: str | None = None

    def start(self, command: list[str], shell_command: str, working_directory: str | None = None) -> dict[str, Any]:
        if not command:
            raise ValueError("Command must not be empty")

        cwd = self._resolve_workdir(working_directory)

        with self._lock:
            if self._state == "running":
                raise RuntimeError("A cyanrip process is already running.")

            self._reset_for_new_job(command, shell_command, cwd)

            try:
                self._process = subprocess.Popen(
                    command,
                    cwd=cwd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    universal_newlines=True,
                    env=self._build_process_env(),
                )
            except FileNotFoundError as exc:
                self._state = "failed"
                self._finished_at = time.time()
                self._append_log(f"Error: binary not found ({command[0]})")
                raise FileNotFoundError(f"Binary not found: {command[0]}") from exc
            except OSError as exc:
                self._state = "failed"
                self._finished_at = time.time()
                self._append_log(f"Start failed: {exc}")
                raise

            self._reader_thread = threading.Thread(target=self._stream_output, daemon=True)
            self._reader_thread.start()

            return self.snapshot()

    def stop(self) -> dict[str, Any]:
        proc: subprocess.Popen[str] | None = None
        with self._lock:
            if self._state != "running" or self._process is None:
                return self.snapshot()
            self._stop_requested = True
            proc = self._process
            self._append_log("Stop requested: asking cyanrip to terminate cleanly...")

        assert proc is not None
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

        return self.snapshot()

    def reset_runtime_state(self) -> None:
        with self._lock:
            if self._state == "running" and self._process is not None:
                raise RuntimeError("A running rip process cannot be reset.")

            self._state = "idle"
            self._job_id = None
            self._command = []
            self._shell_command = ""
            self._working_directory = None
            self._started_at = None
            self._finished_at = None
            self._returncode = None
            self._process = None
            self._reader_thread = None
            self._stop_requested = False
            self._next_log_index = 0
            self._logs.clear()

    def update_scan_result(
        self,
        disc_info: dict[str, Any] | None,
        tracks: list[dict[str, Any]] | None,
        *,
        returncode: int,
        error: str | None = None,
    ) -> None:
        with self._lock:
            self._disc_info = copy.deepcopy(disc_info) if isinstance(disc_info, dict) else {}

            raw_tracks = tracks if isinstance(tracks, list) else []
            self._disc_tracks = [copy.deepcopy(item) for item in raw_tracks if isinstance(item, dict)]

            normalized_tracks = self._normalize_scan_tracks(self._disc_tracks)
            if normalized_tracks:
                self._rip_tracks = {item["number"]: item for item in normalized_tracks}
                self._rip_meta_disc_tracks = len(normalized_tracks)
                if self._rip_meta_planned_track_numbers is None:
                    self._rip_meta_total_tracks = len(normalized_tracks)
            elif returncode == 0:
                self._rip_tracks = {}
                self._rip_meta_disc_tracks = None
                self._rip_meta_total_tracks = 0
                self._rip_meta_planned_track_numbers = None

            self._scan_last_returncode = returncode
            self._scan_last_error = error
            self._scan_last_success = returncode == 0 and not error
            self._scan_updated_at = time.time()

            # A fresh scan resets transient rip progress signals.
            self._active_track_no = None
            self._rip_meta_current_track_no = None
            self._rip_meta_current_track_progress = 0.0
            self._rip_meta_eta = None

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            oldest_idx = self._logs[0].index if self._logs else self._next_log_index
            track_rows = [copy.deepcopy(self._rip_tracks[number]) for number in sorted(self._rip_tracks)]
            return {
                "job_id": self._job_id,
                "state": self._state,
                "is_running": self._state == "running",
                "command": list(self._command),
                "shell_command": self._shell_command,
                "working_directory": self._working_directory,
                "started_at": self._iso(self._started_at),
                "finished_at": self._iso(self._finished_at),
                "returncode": self._returncode,
                "log_next_index": self._next_log_index,
                "log_oldest_index": oldest_idx,
                "log_buffer_size": len(self._logs),
                "scan": {
                    "last_success": self._scan_last_success,
                    "last_returncode": self._scan_last_returncode,
                    "last_error": self._scan_last_error,
                    "updated_at": self._iso(self._scan_updated_at),
                },
                "disc": {
                    "info": copy.deepcopy(self._disc_info),
                    "tracks": copy.deepcopy(self._disc_tracks),
                },
                "rip": {
                    "tracks": track_rows,
                    "disc_tracks": self._rip_meta_disc_tracks,
                    "planned_track_numbers": copy.deepcopy(self._rip_meta_planned_track_numbers),
                    "total_tracks": self._rip_meta_total_tracks,
                    "current_track_no": self._rip_meta_current_track_no,
                    "current_track_progress": self._rip_meta_current_track_progress,
                    "eta": self._rip_meta_eta,
                },
            }

    def logs(self, since: int | None = None) -> dict[str, Any]:
        with self._lock:
            oldest_idx = self._logs[0].index if self._logs else self._next_log_index
            if since is None:
                since_idx = oldest_idx
            else:
                since_idx = max(since, oldest_idx)

            lines = [
                {"index": line.index, "line": line.line}
                for line in self._logs
                if line.index >= since_idx
            ]

            return {
                "lines": lines,
                "next_index": self._next_log_index,
                "oldest_index": oldest_idx,
            }

    def _reset_for_new_job(self, command: list[str], shell_command: str, cwd: str) -> None:
        self._state = "running"
        self._job_id = uuid.uuid4().hex[:12]
        self._command = list(command)
        self._shell_command = shell_command
        self._working_directory = cwd
        self._started_at = time.time()
        self._finished_at = None
        self._returncode = None
        self._process = None
        self._reader_thread = None
        self._stop_requested = False
        self._next_log_index = 0
        self._logs.clear()

        # Once a rip starts, we move status from "scan completed" to runtime state.
        self._scan_last_success = False
        self._scan_last_error = None
        self._reset_rip_runtime_for_job(command)

        self._append_log(f"Job {self._job_id} started")
        self._append_log(f"Working directory: {cwd}")
        self._append_log(f"Command: {shell_command}")

    def _reset_rip_runtime_for_job(self, command: list[str]) -> None:
        self._active_track_no = None
        self._rip_meta_current_track_no = None
        self._rip_meta_current_track_progress = 0.0
        self._rip_meta_eta = None

        selected_tracks = self._parse_track_selection_from_command(command)
        self._rip_meta_planned_track_numbers = selected_tracks if selected_tracks else None

        normalized_tracks = self._normalize_scan_tracks(self._disc_tracks)
        self._rip_tracks = {item["number"]: item for item in normalized_tracks}

        if self._rip_tracks:
            self._rip_meta_disc_tracks = len(self._rip_tracks)
        elif self._rip_meta_disc_tracks is not None and self._rip_meta_disc_tracks <= 0:
            self._rip_meta_disc_tracks = None

        if self._rip_meta_planned_track_numbers is not None:
            self._rip_meta_total_tracks = len(self._rip_meta_planned_track_numbers)
        elif self._rip_meta_disc_tracks:
            self._rip_meta_total_tracks = self._rip_meta_disc_tracks
        else:
            self._rip_meta_total_tracks = len(self._rip_tracks)

        self._mark_planned_tracks()

    def _append_log(self, line: str) -> None:
        normalized = line.rstrip("\n")
        self._consume_runtime_signal(normalized)
        if self._should_filter_log_line(normalized):
            return
        self._logs.append(LogLine(index=self._next_log_index, line=normalized))
        self._next_log_index += 1

    def _should_filter_log_line(self, raw_line: str) -> bool:
        line = (raw_line or "").strip()
        if not line:
            return True
        return bool(_PROGRESS_RE.match(line))

    def _consume_runtime_signal(self, raw_line: str) -> None:
        line = (raw_line or "").strip()
        if not line:
            return

        disc_tracks_match = _DISC_TRACKS_RE.match(line)
        if disc_tracks_match:
            self._rip_meta_disc_tracks = int(disc_tracks_match.group(1))
            if self._rip_meta_planned_track_numbers is None:
                self._rip_meta_total_tracks = self._rip_meta_disc_tracks
            return

        tracks_to_rip_match = _TRACKS_TO_RIP_RE.match(line)
        if tracks_to_rip_match:
            self._apply_tracks_to_rip_declaration(tracks_to_rip_match.group(1).strip())
            return

        track_info_match = _TRACK_INFO_RE.match(line)
        if track_info_match:
            track_no = int(track_info_match.group(1))
            self._active_track_no = track_no
            self._upsert_rip_track(track_no, status="detected")
            return

        track_done_match = _TRACK_DONE_RE.match(line)
        if track_done_match:
            track_no = int(track_done_match.group(1))
            self._active_track_no = track_no
            self._rip_meta_current_track_no = track_no
            self._rip_meta_current_track_progress = 100.0
            self._upsert_rip_track(track_no, status="done", progress=100.0)
            return

        progress_match = _PROGRESS_RE.match(line)
        if progress_match:
            track_no = int(progress_match.group(1))
            progress = float(progress_match.group(2))
            self._active_track_no = track_no
            self._rip_meta_current_track_no = track_no
            self._rip_meta_current_track_progress = self._clamp_float(progress, 0.0, 100.0, 0.0)

            eta_match = _ETA_RE.search(line)
            if eta_match:
                self._rip_meta_eta = eta_match.group(1).strip()

            self._upsert_rip_track(track_no, status="running", progress=progress)
            return

        if self._active_track_no is None:
            return

        duration_match = _DURATION_RE.match(line)
        if duration_match:
            self._upsert_rip_track(self._active_track_no, duration=duration_match.group(1).strip())
            return

        title_match = _TITLE_RE.match(line)
        if title_match:
            self._upsert_rip_track(self._active_track_no, title=title_match.group(1).strip())
            return

        artist_match = _ARTIST_RE.match(line)
        if artist_match:
            self._upsert_rip_track(self._active_track_no, artist=artist_match.group(1).strip())
            return

        accurip_match = _ACCURIP_RE.match(line)
        if accurip_match:
            self._upsert_rip_track(
                self._active_track_no,
                accurip_text=accurip_match.group(1).strip(),
                accurip_max_confidence=self._normalize_optional_int(accurip_match.group(2)),
            )
            return

        accurip_detail_match = _ACCURIP_DETAIL_RE.match(line)
        if accurip_detail_match:
            detail = (accurip_detail_match.group(1) or "").strip()
            confidence = None
            if not detail:
                return

            conf_match = _ACCURIP_CONF_RE.search(detail)
            confidence = self._normalize_optional_int(conf_match.group(1) if conf_match else None)
            if confidence is None and "full confidence" in detail.lower():
                current = self._rip_tracks.get(self._active_track_no)
                confidence = self._normalize_optional_int(current.get("accurip_max_confidence") if current else None)
            self._upsert_rip_track(
                self._active_track_no,
                accurip_text=detail if detail else None,
                accurip_confidence=confidence,
            )
            return

        lowered = line.lower()
        if lowered.startswith("error") or "failed" in lowered or "ripping incomplete" in lowered:
            self._upsert_rip_track(self._active_track_no, status="error")

    def _stream_output(self) -> None:
        proc: subprocess.Popen[str] | None = None
        with self._lock:
            proc = self._process

        if proc is None:
            return

        try:
            assert proc.stdout is not None
            pending = ""
            while True:
                chunk = proc.stdout.read(256)
                if chunk == "":
                    break
                pending += chunk
                pending = self._flush_pending_lines(pending)

            if pending:
                with self._lock:
                    self._append_log(pending)
        finally:
            returncode = proc.wait()
            with self._lock:
                self._returncode = returncode
                self._finished_at = time.time()
                self._process = None
                self._reader_thread = None

                if self._stop_requested:
                    self._state = "stopped"
                    self._mark_running_tracks_aborted()
                    self._append_log("cyanrip was stopped.")
                elif returncode == 0:
                    self._state = "finished"
                    self._append_log("cyanrip finished successfully.")
                else:
                    self._state = "failed"
                    self._append_log(f"cyanrip exited with code {returncode}.")

                self._stop_requested = False

    def _mark_running_tracks_aborted(self) -> None:
        for row in self._rip_tracks.values():
            status = str(row.get("status") or "").strip().lower()
            if status in {"running", "queued"}:
                row["status"] = "aborted"
                row["accurip"] = self._format_accurip(row)

    def _flush_pending_lines(self, pending: str) -> str:
        start = 0
        for idx, ch in enumerate(pending):
            if ch not in ("\r", "\n"):
                continue

            if idx > start:
                text = pending[start:idx]
                with self._lock:
                    self._append_log(text)
            start = idx + 1

        if start <= 0:
            return pending
        return pending[start:]

    def _apply_tracks_to_rip_declaration(self, raw_value: str) -> None:
        value = str(raw_value or "").strip().lower()
        if not value:
            return

        if value == "all":
            self._rip_meta_planned_track_numbers = None
            if self._rip_meta_disc_tracks and self._rip_meta_disc_tracks > 0:
                self._rip_meta_total_tracks = self._rip_meta_disc_tracks
            elif self._rip_tracks:
                self._rip_meta_total_tracks = len(self._rip_tracks)
            self._mark_planned_tracks()
            return

        if value == "none":
            self._rip_meta_total_tracks = 0
            self._rip_meta_planned_track_numbers = []
            self._mark_planned_tracks()
            return

        values: list[int] = []
        seen: set[int] = set()
        for item in re.findall(r"\d+", raw_value):
            number = int(item)
            if number <= 0 or number in seen:
                continue
            seen.add(number)
            values.append(number)

        if not values:
            return

        values.sort()
        self._rip_meta_planned_track_numbers = values
        self._rip_meta_total_tracks = len(values)
        self._mark_planned_tracks()

    def _mark_planned_tracks(self) -> None:
        if not self._rip_tracks:
            return

        planned = self._rip_meta_planned_track_numbers
        planned_set = set(planned) if planned is not None else None

        for track_no, row in self._rip_tracks.items():
            in_plan = planned_set is None or track_no in planned_set
            if in_plan:
                if row["status"] in ("detected", "queued"):
                    row["status"] = "queued"
                    row["progress"] = 0.0
                    row["accurip_text"] = ""
                    row["accurip_confidence"] = None
            else:
                if row["status"] in ("queued", "running"):
                    row["status"] = "detected"
                    row["progress"] = 0.0

            row["accurip"] = self._format_accurip(row)

    def _upsert_rip_track(self, track_no: int, **patch: Any) -> None:
        row = self._ensure_rip_track(track_no)

        title = patch.get("title", row["title"])
        artist = patch.get("artist", row["artist"])
        duration = patch.get("duration", row["duration"])

        row["title"] = str(title).strip() if title else f"Track {track_no:02d}"
        row["artist"] = str(artist).strip() if artist else ""
        row["duration"] = str(duration).strip() if duration else ""

        if "status" in patch and patch["status"] is not None:
            row["status"] = self._normalize_track_status(patch["status"])

        if "progress" in patch and patch["progress"] is not None:
            row["progress"] = self._clamp_float(patch["progress"], 0.0, 100.0, row["progress"])

        if "accurip_text" in patch:
            value = patch["accurip_text"]
            row["accurip_text"] = "" if value is None else str(value).strip()

        if "accurip_confidence" in patch:
            row["accurip_confidence"] = self._normalize_optional_int(patch["accurip_confidence"])

        if "accurip_max_confidence" in patch:
            row["accurip_max_confidence"] = self._normalize_optional_int(patch["accurip_max_confidence"])

        self._reconcile_accurip_confidence(row)
        row["accurip"] = self._format_accurip(row)

        if self._rip_meta_disc_tracks is None and self._rip_tracks:
            self._rip_meta_disc_tracks = len(self._rip_tracks)

        if self._rip_meta_total_tracks <= 0:
            if self._rip_meta_planned_track_numbers is not None:
                self._rip_meta_total_tracks = len(self._rip_meta_planned_track_numbers)
            elif self._rip_meta_disc_tracks:
                self._rip_meta_total_tracks = self._rip_meta_disc_tracks
            else:
                self._rip_meta_total_tracks = len(self._rip_tracks)

    def _ensure_rip_track(self, track_no: int) -> dict[str, Any]:
        number = int(track_no)
        if number <= 0:
            raise ValueError("Track number must be greater than 0")

        existing = self._rip_tracks.get(number)
        if existing is not None:
            return existing

        row = {
            "number": number,
            "title": f"Track {number:02d}",
            "artist": "",
            "duration": "",
            "status": "detected",
            "progress": 0.0,
            "accurip": "",
            "accurip_text": "",
            "accurip_confidence": None,
            "accurip_max_confidence": None,
        }
        self._rip_tracks[number] = row

        if self._rip_meta_disc_tracks is None:
            self._rip_meta_disc_tracks = len(self._rip_tracks)
        return row

    def _normalize_scan_tracks(self, tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []

        for track in tracks:
            number = self._normalize_optional_int(track.get("number"))
            if number is None or number <= 0:
                continue

            row = {
                "number": number,
                "title": str(track.get("title") or f"Track {number:02d}").strip(),
                "artist": str(track.get("artist") or "").strip(),
                "duration": str(track.get("duration") or "").strip(),
                "status": self._normalize_track_status(track.get("status") or "detected"),
                "progress": self._clamp_float(track.get("progress"), 0.0, 100.0, 0.0),
                "accurip_text": str(track.get("accurip_text") or track.get("accurip") or "").strip(),
                "accurip_confidence": self._normalize_optional_int(track.get("accurip_confidence")),
                "accurip_max_confidence": self._normalize_optional_int(track.get("accurip_max_confidence")),
            }
            row["accurip"] = self._format_accurip(row)
            normalized.append(row)

        normalized.sort(key=lambda item: item["number"])
        return normalized

    @staticmethod
    def _parse_track_selection_from_command(command: list[str]) -> list[int]:
        values: list[int] = []

        for idx, arg in enumerate(command[:-1]):
            if arg != "-l":
                continue
            raw = command[idx + 1]
            for part in str(raw).split(","):
                chunk = part.strip()
                if not chunk:
                    continue
                try:
                    number = int(chunk)
                except ValueError:
                    continue
                if number > 0 and number not in values:
                    values.append(number)

        values.sort()
        return values

    @staticmethod
    def _normalize_track_status(status: Any) -> str:
        value = str(status or "").strip().lower()
        if value in ("running", "ripping", "encoding"):
            return "running"
        if value in ("done", "finished", "ok"):
            return "done"
        if value in ("error", "failed"):
            return "error"
        if value in ("queued", "waiting"):
            return "queued"
        if value in ("aborted", "cancelled", "stopped"):
            return "aborted"
        return "detected"

    @staticmethod
    def _normalize_optional_int(value: Any) -> int | None:
        if value in (None, ""):
            return None
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _clamp_float(value: Any, minimum: float, maximum: float, default: float) -> float:
        try:
            parsed = float(str(value).strip())
        except (TypeError, ValueError, AttributeError):
            return default
        return max(minimum, min(maximum, parsed))

    @staticmethod
    def _format_accurip(track: dict[str, Any]) -> str:
        confidence = CyanripJobRunner._normalize_optional_int(track.get("accurip_confidence"))
        max_confidence = CyanripJobRunner._normalize_optional_int(track.get("accurip_max_confidence"))
        text = str(track.get("accurip_text") or "").strip()

        if confidence is not None and (max_confidence is None or confidence > max_confidence):
            max_confidence = confidence

        if confidence is not None and max_confidence is not None:
            return f"{confidence}/{max_confidence}"
        if confidence is not None:
            return str(confidence)
        return text

    @staticmethod
    def _reconcile_accurip_confidence(track: dict[str, Any]) -> None:
        confidence = CyanripJobRunner._normalize_optional_int(track.get("accurip_confidence"))
        max_confidence = CyanripJobRunner._normalize_optional_int(track.get("accurip_max_confidence"))
        if confidence is not None and (max_confidence is None or confidence > max_confidence):
            track["accurip_max_confidence"] = confidence

    @staticmethod
    def _resolve_workdir(working_directory: str | None) -> str:
        if not working_directory:
            return os.getcwd()

        cwd = os.path.abspath(os.path.expanduser(working_directory))
        if not os.path.isdir(cwd):
            raise NotADirectoryError(f"Working directory does not exist: {cwd}")
        return cwd

    @staticmethod
    def _build_process_env() -> dict[str, str]:
        return os.environ.copy()

    @staticmethod
    def _iso(timestamp: float | None) -> str | None:
        if timestamp is None:
            return None
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(timestamp))
