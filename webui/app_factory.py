from __future__ import annotations

import copy
import io
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from flask import Flask, jsonify, render_template, request, send_file

try:
    from flask_sock import Sock
except ModuleNotFoundError as exc:  # pragma: no cover - optional dependency
    Sock = None
    SOCK_IMPORT_ERROR = f"flask_sock konnte nicht importiert werden: {exc}"
except Exception as exc:  # pragma: no cover - defensive guard for packaged environments
    Sock = None
    SOCK_IMPORT_ERROR = f"flask_sock Importfehler: {exc}"
else:
    SOCK_IMPORT_ERROR = ""

from .command_builder import (
    COVERART_LOOKUP_SIZES,
    DEFAULT_CONFIG,
    PREGAP_ACTIONS,
    SANITATION_MODES,
    SUPPORTED_OUTPUTS,
    CommandBuilder,
    CommandBuilderError,
)
from .device_probe import list_optical_drives
from .runner import CyanripJobRunner
from .scan_parser import parse_scan_output

PROJECT_ROOT = Path(__file__).resolve().parent.parent
APP_IS_FROZEN = bool(
    getattr(sys, "frozen", False)
    or getattr(sys, "_MEIPASS", None)
    or "_internal" in Path(__file__).resolve().parts
)


def _env_path(name: str) -> Path | None:
    value = str(os.environ.get(name) or "").strip()
    if not value:
        return None
    try:
        return Path(value).expanduser().resolve()
    except OSError:
        return Path(value).expanduser()


def _runtime_data_root() -> Path:
    explicit_output = _env_path("CYANRIP_WEBUI_DEFAULT_OUTPUT_DIR")
    if explicit_output is not None:
        return explicit_output.parent

    appimage = _env_path("APPIMAGE")
    if appimage is not None:
        return appimage.parent

    if APP_IS_FROZEN:
        return Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "cyanrip-webui"

    return PROJECT_ROOT


def _runtime_default_output_dir(data_root: Path) -> Path:
    explicit_output = _env_path("CYANRIP_WEBUI_DEFAULT_OUTPUT_DIR")
    if explicit_output is not None:
        return explicit_output
    return data_root / "output"


def _runtime_default_binary_path() -> str:
    bundled = _env_path("CYANRIP_WEBUI_BUNDLED_CYANRIP")
    if bundled is not None:
        return str(bundled)

    appdir = _env_path("APPDIR") or _env_path("CYANRIP_WEBUI_APPDIR")
    if APP_IS_FROZEN and appdir is not None:
        candidate = appdir / "usr" / "bin" / "cyanrip"
        if candidate.exists():
            return str(candidate)

    return "./bin/cyanrip"


APP_DATA_ROOT = _runtime_data_root()
DEFAULT_WORKING_DIRECTORY = _runtime_default_output_dir(APP_DATA_ROOT)
DEFAULT_BINARY_PATH = _runtime_default_binary_path()
HTTP_FALLBACK_ENABLED = str(os.environ.get("CYANRIP_WEBUI_HTTP_FALLBACK") or "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
DEFAULT_UI_SETTINGS: dict[str, Any] = {
    "binary_path": DEFAULT_BINARY_PATH,
    "working_directory": str(DEFAULT_WORKING_DIRECTORY) if APP_IS_FROZEN else "./output",
    "language": "en",
    "device_profiles": {},
    "misc_offset": 0,
}
COVER_CACHE_TTL_SECONDS = 900
COVER_CACHE_MAX_ITEMS = 12
COVER_FETCH_MAX_BYTES = 8 * 1024 * 1024
_RIP_PROGRESS_LINE_RE = re.compile(
    r"^Ripping(?:\s+and\s+encoding)?\s+track\s+\d+,\s+progress\s+-\s+[0-9]+(?:\.[0-9]+)?%",
    re.IGNORECASE,
)
_MB_RELEASE_ID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE)
_MB_RELEASE_OPTION_RE = re.compile(
    r"^\s*\d+\s*\(ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\s*:\s*(.+?)\s*$",
    re.IGNORECASE,
)
_MULTI_RELEASE_HINT_RE = re.compile(
    r"(multiple\s+releases?|mehrere\s+releases?|release\s+id|musicbrainz)",
    re.IGNORECASE,
)
_NO_RELEASE_HINT_RE = re.compile(
    r"(unable\s+to\s+find\s+release\s+info|no\s+releases?\s+found|discid\s+has\s+no\s+associated\s+releases|"
    r"metadaten?.*nicht|release\s+info.*nicht)",
    re.IGNORECASE,
)
_MB_CD_TOC_ATTACH_RE = re.compile(r"https://musicbrainz\.org/cdtoc/attach\?[^\s<>\"]+", re.IGNORECASE)
_WS_RPC_ALLOWED: set[tuple[str, str]] = {
    ("GET", "/api/settings"),
    ("POST", "/api/settings"),
    ("POST", "/api/probe"),
    ("GET", "/api/fs/directories"),
    ("GET", "/api/drives"),
    ("POST", "/api/drives/offset"),
    ("POST", "/api/session/reset"),
    ("POST", "/api/preview"),
    ("POST", "/api/scan"),
    ("POST", "/api/start"),
    ("POST", "/api/stop"),
    ("POST", "/api/eject"),
    ("GET", "/api/status"),
    ("GET", "/api/logs"),
}


def create_app() -> Flask:
    app = Flask(__name__)
    if Sock is not None:
        app.config["SOCK_SERVER_OPTIONS"] = {"ping_interval": 25}
    sock = Sock(app) if Sock is not None else None
    runner = CyanripJobRunner()
    state_lock = threading.RLock()
    cover_cache: dict[str, dict[str, Any]] = {}

    _ensure_runtime_directories()

    ui_state: dict[str, Any] = {
        "session_id": _new_session_id(),
        "phase": "idle",
        "scan_signature": None,
        "scan_updated_at": None,
        "binary_probe": {
            "ok": False,
            "binary_path": DEFAULT_UI_SETTINGS["binary_path"],
            "version": "",
            "returncode": None,
            "error": "not_checked",
            "checked_at": None,
        },
    }
    scan_runtime: dict[str, Any] = {
        "process": None,
        "cancel_requested": False,
        "log_lines": [],
        "log_next_index": 0,
        "last_command": [],
        "last_shell_command": "",
    }

    _refresh_binary_probe(ui_state, state_lock, DEFAULT_UI_SETTINGS["binary_path"])

    def status_payload() -> dict[str, Any]:
        snap = runner.snapshot()
        with state_lock:
            scan_process = scan_runtime.get("process")
            if scan_process is not None and scan_process.poll() is not None:
                scan_runtime["process"] = None
                scan_process = None

            scan_active = scan_process is not None and scan_process.poll() is None
            current_phase = str(ui_state.get("phase") or "")

            if scan_active:
                ui_state["phase"] = "scanning"
            elif snap.get("is_running"):
                ui_state["phase"] = "ripping"
            else:
                runner_state = str(snap.get("state") or "")

                if current_phase in {"idle", "scanned", "scan_required", "scan_error"}:
                    if current_phase == "idle":
                        ui_state["phase"] = "idle"
                    elif current_phase in {"scanned", "scan_required", "scan_error"}:
                        ui_state["phase"] = current_phase
                elif runner_state == "finished":
                    ui_state["phase"] = "finished"
                elif runner_state == "failed":
                    ui_state["phase"] = "failed"
                elif runner_state == "stopped":
                    if current_phase in {"ripping", "finished", "failed", "stopped"}:
                        ui_state["phase"] = "stopped"
                    elif ui_state.get("scan_signature"):
                        ui_state["phase"] = "scanned"
                    else:
                        ui_state["phase"] = "idle"
                elif ui_state.get("scan_signature"):
                    ui_state["phase"] = "scanned"
                else:
                    ui_state["phase"] = "idle"

            phase = str(ui_state.get("phase") or "")
            log_source = _determine_log_source(phase=phase, scan_active=scan_active, runner_snapshot=snap)
            if log_source == "scan":
                log_meta = _scan_logs_snapshot(scan_runtime=scan_runtime, since=None)
                last_shell = str(scan_runtime.get("last_shell_command") or "")
            else:
                log_meta = runner.logs(since=None)
                last_shell = str(snap.get("shell_command") or "")

        enriched = _enrich_snapshot(snap, ui_state, state_lock)
        enriched["log_source"] = log_source
        enriched["log_next_index"] = log_meta.get("next_index")
        enriched["log_oldest_index"] = log_meta.get("oldest_index")
        if last_shell:
            enriched["active_shell_command"] = last_shell
        return enriched

    @app.get("/")
    def index() -> str:
        return render_template(
            "index.html",
            default_config=DEFAULT_CONFIG,
            supported_outputs=SUPPORTED_OUTPUTS,
            sanitation_modes=SANITATION_MODES,
            pregap_actions=PREGAP_ACTIONS,
            coverart_lookup_sizes=COVERART_LOOKUP_SIZES,
            default_working_directory=DEFAULT_UI_SETTINGS["working_directory"],
            initial_settings=DEFAULT_UI_SETTINGS,
        )

    @app.get("/api/settings")
    def get_settings() -> Any:
        return jsonify(
            {
                "settings": copy.deepcopy(DEFAULT_UI_SETTINGS),
                "binary": _binary_probe_snapshot(ui_state, state_lock),
                "websocket_available": bool(sock is not None),
                "websocket_error": SOCK_IMPORT_ERROR,
                "http_fallback_enabled": HTTP_FALLBACK_ENABLED,
            }
        )

    @app.post("/api/settings")
    def update_settings() -> Any:
        payload = _json_payload()
        raw_settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else payload
        settings = _effective_settings(raw_settings if isinstance(raw_settings, dict) else {})
        _refresh_binary_probe(ui_state, state_lock, settings.get("binary_path") or DEFAULT_BINARY_PATH)

        return jsonify(
            {
                "settings": settings,
                "binary": _binary_probe_snapshot(ui_state, state_lock),
                "persisted": False,
            }
        )

    @app.post("/api/probe")
    def probe() -> Any:
        payload = _json_payload()
        raw_binary = str(payload.get("binary_path") or DEFAULT_UI_SETTINGS["binary_path"] or "").strip()

        probe = _probe_binary_version(raw_binary)

        with state_lock:
            ui_state["binary_probe"] = probe

        return jsonify(probe)

    @app.get("/api/fs/directories")
    def list_directories() -> Any:
        raw_path = request.args.get("path", default="", type=str)

        try:
            data = _list_directories(raw_path)
        except PermissionError as exc:
            return jsonify({"error": str(exc)}), 403
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except OSError as exc:
            return jsonify({"error": f"Verzeichnis konnte nicht gelesen werden: {exc}"}), 500

        return jsonify(data)

    @app.get("/api/drives")
    def drives() -> Any:
        profile_map = _read_profile_map_from_request()
        drives_list = list_optical_drives(profile_map)
        return jsonify({"drives": drives_list})

    @app.get("/api/cover")
    def cover_preview() -> Any:
        raw_url = str(request.args.get("url", default="") or "").strip()
        raw_path = str(request.args.get("path", default="") or "").strip()
        raw_release_id = str(request.args.get("release_id", default="") or "").strip().lower()

        if not raw_url and raw_path and raw_path.lower().startswith(("http://", "https://")):
            raw_url = raw_path
            raw_path = ""

        if (
            not raw_url
            and raw_path
            and raw_release_id
            and _MB_RELEASE_ID_RE.search(raw_release_id)
            and "cover art db" in raw_path.lower()
        ):
            raw_url = f"https://coverartarchive.org/release/{raw_release_id}/front"
            raw_path = ""

        if raw_url:
            try:
                data, mime = _fetch_remote_cover(
                    raw_url=raw_url,
                    cache=cover_cache,
                    lock=state_lock,
                )
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400
            except OSError as exc:
                return jsonify({"error": str(exc)}), 502

            return send_file(io.BytesIO(data), mimetype=mime, conditional=False, max_age=120)

        if not raw_path:
            return jsonify({"error": "Pfad oder URL fehlt."}), 400

        try:
            resolved = Path(raw_path).expanduser().resolve()
        except OSError:
            return jsonify({"error": "Ungueltiger Cover-Pfad."}), 400

        if not resolved.exists() or not resolved.is_file():
            return jsonify({"error": "Cover-Datei nicht gefunden."}), 404

        mime, _ = mimetypes.guess_type(str(resolved))
        if not mime or not mime.startswith("image/"):
            return jsonify({"error": "Datei ist kein unterstuetztes Bild."}), 415

        return send_file(resolved, mimetype=mime, conditional=True)

    @app.post("/api/drives/offset")
    def update_drive_offset() -> Any:
        payload = _json_payload()
        device_id = str(payload.get("device_id") or "").strip()
        if not device_id:
            return jsonify({"error": "device_id fehlt."}), 400

        profile_map = _coerce_device_profiles(payload.get("device_profiles"))
        misc_offset = _parse_optional_int(payload.get("misc_offset"), fallback=0)
        offset_raw = payload.get("offset")

        if device_id == "__misc__":
            misc_offset = 0 if offset_raw in (None, "") else _parse_optional_int(offset_raw, fallback=0)
        elif offset_raw in (None, ""):
            profile_map.pop(device_id, None)
        else:
            try:
                offset = int(str(offset_raw).strip())
            except (TypeError, ValueError):
                return jsonify({"error": "Offset muss eine Ganzzahl sein."}), 400
            profile_map[device_id] = {"offset": offset}

        settings = _effective_settings(
            {
                "device_profiles": profile_map,
                "misc_offset": misc_offset,
            }
        )
        drives_list = list_optical_drives(settings.get("device_profiles"))
        return jsonify({"settings": settings, "drives": drives_list, "persisted": False})

    @app.post("/api/session/reset")
    def reset_session() -> Any:
        with state_lock:
            scan_process = scan_runtime.get("process")
        if runner.snapshot().get("is_running") or (scan_process is not None and scan_process.poll() is None):
            return jsonify({"error": "Ein Scan- oder Rip-Job laeuft. Bitte zuerst stoppen."}), 409

        runner.reset_runtime_state()
        runner.update_scan_result({}, [], returncode=0)

        with state_lock:
            ui_state["session_id"] = _new_session_id()
            ui_state["phase"] = "idle"
            ui_state["scan_signature"] = None
            ui_state["scan_updated_at"] = None
            scan_runtime["process"] = None
            scan_runtime["cancel_requested"] = False
            _reset_scan_runtime_logs(scan_runtime)

        return jsonify(_enriched_status_snapshot(runner, ui_state, state_lock))

    @app.post("/api/preview")
    def preview() -> Any:
        payload = _json_payload()
        binary_path_raw = str(payload.get("binary_path") or DEFAULT_UI_SETTINGS["binary_path"] or "").strip()
        config = payload.get("config") or {}
        mode = str(payload.get("mode") or "rip").strip().lower()

        try:
            binary_path = _resolve_binary_path(binary_path_raw)
            if mode == "scan":
                preview_config = _scan_config_from_user(config)
            else:
                preview_config = config
            result = CommandBuilder.build(binary_path=binary_path, config=preview_config)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except CommandBuilderError as exc:
            return jsonify({"error": str(exc)}), 400

        return jsonify({"command": result.argv, "shell_command": result.shell})

    @app.post("/api/scan")
    def scan() -> Any:
        if runner.snapshot()["is_running"]:
            return jsonify({"error": "Ein Rip-Job laeuft bereits. Bitte zuerst stoppen oder warten."}), 409
        try:
            runner.reset_runtime_state()
        except RuntimeError:
            return jsonify({"error": "Ein Rip-Job laeuft bereits. Bitte zuerst stoppen oder warten."}), 409
        with state_lock:
            active_scan = scan_runtime.get("process")
            if active_scan is not None and active_scan.poll() is None:
                return jsonify({"error": "Ein CD-Scan laeuft bereits."}), 409
            if active_scan is not None and active_scan.poll() is not None:
                scan_runtime["process"] = None
            scan_runtime["cancel_requested"] = False
            _reset_scan_runtime_logs(scan_runtime)
            ui_state["phase"] = "scanning"
            ui_state["scan_updated_at"] = _now_iso()

        payload = _json_payload()
        binary_path_raw = str(payload.get("binary_path") or DEFAULT_UI_SETTINGS["binary_path"] or "").strip()
        working_directory_raw = str(payload.get("working_directory") or DEFAULT_UI_SETTINGS["working_directory"] or "").strip()
        config = payload.get("config") or {}

        try:
            binary_path = _resolve_binary_path(binary_path_raw)
            working_directory = _resolve_working_directory(working_directory_raw)
            scan_result = _run_disc_scan(
                binary_path=binary_path,
                working_directory=working_directory,
                config=config,
                state_lock=state_lock,
                scan_runtime=scan_runtime,
            )
        except ValueError as exc:
            with state_lock:
                if ui_state.get("phase") == "scanning":
                    ui_state["phase"] = "idle"
            return jsonify({"error": str(exc)}), 400
        except CommandBuilderError as exc:
            with state_lock:
                if ui_state.get("phase") == "scanning":
                    ui_state["phase"] = "idle"
            return jsonify({"error": str(exc)}), 400
        except OSError as exc:
            with state_lock:
                if ui_state.get("phase") == "scanning":
                    ui_state["phase"] = "idle"
            return jsonify({"error": f"CD-Scan konnte nicht gestartet werden: {exc}"}), 500

        parsed = scan_result["parsed"]
        returncode = scan_result["returncode"]
        signature = _disc_signature(parsed.get("disc") or {})
        scan_was_cancelled = bool(scan_result.get("cancelled"))

        if not scan_was_cancelled:
            runner.update_scan_result(
                parsed.get("disc") or {},
                parsed.get("tracks") or [],
                returncode=returncode,
                error=scan_result.get("error"),
            )

        with state_lock:
            if scan_was_cancelled:
                ui_state["phase"] = "idle"
            else:
                previous = ui_state.get("scan_signature")
                if signature and previous and signature != previous:
                    ui_state["session_id"] = _new_session_id()

                if returncode == 0 and not scan_result.get("error"):
                    ui_state["phase"] = "scanned"
                    ui_state["scan_signature"] = signature
                else:
                    ui_state["phase"] = "scan_error"
                    ui_state["scan_signature"] = signature or ui_state.get("scan_signature")

            ui_state["scan_updated_at"] = _now_iso()
            scan_runtime["cancel_requested"] = False

        payload_out: dict[str, Any] = {
            "returncode": returncode,
            "command": scan_result.get("command"),
            "shell_command": scan_result.get("shell_command"),
            "disc": parsed.get("disc") or {},
            "tracks": parsed.get("tracks") or [],
            "signature": signature,
            "session": _session_snapshot(ui_state, state_lock),
            "output_lines": scan_result.get("output_lines") or 0,
            "output_preview": scan_result.get("output_preview") or "",
        }
        release_candidates = scan_result.get("release_candidates") or []
        release_options = scan_result.get("release_options") or []
        if release_candidates or release_options:
            payload_out["release_candidates"] = release_candidates
            payload_out["release_options"] = release_options
            payload_out["error_kind"] = "release_selection_required"
            payload_out["error_key"] = "error.releaseSelectionRequired"
        elif scan_result.get("error_kind") == "no_release_found":
            payload_out["error_kind"] = "no_release_found"
            payload_out["error_key"] = "error.noReleaseFound"
            payload_out["musicbrainz_submission_url"] = scan_result.get("musicbrainz_submission_url") or ""
        payload_out["output_snippet"] = payload_out.get("output_preview") or ""

        if scan_was_cancelled:
            payload_out["error"] = "CD-Scan wurde abgebrochen."
            return jsonify(payload_out), 409

        if returncode != 0:
            payload_out["error"] = scan_result.get("error") or f"CD-Scan fehlgeschlagen (Exit-Code {returncode})."
            if payload_out.get("error_kind") in {"release_selection_required", "no_release_found"}:
                return jsonify(payload_out), 409
            payload_out["error_key"] = "error.scanFailedExitCode"
            payload_out["error_vars"] = {"code": returncode}
            return jsonify(payload_out), 422

        return jsonify(payload_out), 200

    @app.post("/api/start")
    def start() -> Any:
        payload = _json_payload()
        binary_path_raw = str(payload.get("binary_path") or DEFAULT_UI_SETTINGS["binary_path"] or "").strip()
        working_directory_raw = str(payload.get("working_directory") or DEFAULT_UI_SETTINGS["working_directory"] or "").strip()
        config = payload.get("config") or {}

        with state_lock:
            scan_process = scan_runtime.get("process")
            if scan_process is not None and scan_process.poll() is None:
                return jsonify({"error": "Ein CD-Scan laeuft noch. Bitte auf den Abschluss warten oder stoppen."}), 409
            scan_signature = ui_state.get("scan_signature")
            current_phase = str(ui_state.get("phase") or "")
        if not scan_signature:
            return jsonify({"error": "Bitte zuerst einen CD-Scan durchfuehren."}), 409
        if current_phase != "scanned":
            return jsonify({"error": "Rip kann nur aus der gescannten Phase gestartet werden. Bitte erneut scannen."}), 409

        try:
            binary_path = _resolve_binary_path(binary_path_raw)
            working_directory = _resolve_working_directory(working_directory_raw)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        try:
            preflight = _run_disc_scan(binary_path=binary_path, working_directory=working_directory, config=config)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except CommandBuilderError as exc:
            return jsonify({"error": str(exc)}), 400
        except OSError as exc:
            return jsonify({"error": f"Vorab-Scan fehlgeschlagen: {exc}"}), 500

        if preflight["returncode"] != 0:
            error_message = preflight.get("error") or f"CD-Scan fehlgeschlagen (Exit-Code {preflight['returncode']})."
            return jsonify({"error": f"Vor dem Rip konnte die Disc nicht verifiziert werden: {error_message}"}), 422

        current_signature = _disc_signature(preflight["parsed"].get("disc") or {})

        with state_lock:
            expected_signature = ui_state.get("scan_signature")

        if expected_signature and current_signature and current_signature != expected_signature:
            runner.update_scan_result(
                preflight["parsed"].get("disc") or {},
                preflight["parsed"].get("tracks") or [],
                returncode=0,
            )
            with state_lock:
                ui_state["session_id"] = _new_session_id()
                ui_state["phase"] = "scan_required"
                ui_state["scan_signature"] = current_signature
                ui_state["scan_updated_at"] = _now_iso()

            return (
                jsonify(
                    {
                        "error": "Die eingelegte Disc hat sich seit dem letzten Scan geaendert. Bitte erneut scannen.",
                        "expected_signature": expected_signature,
                        "current_signature": current_signature,
                        "session": _session_snapshot(ui_state, state_lock),
                    }
                ),
                409,
            )

        try:
            result = CommandBuilder.build(binary_path=binary_path, config=config)
            snap = runner.start(
                command=result.argv,
                shell_command=result.shell,
                working_directory=working_directory,
            )
        except CommandBuilderError as exc:
            return jsonify({"error": str(exc)}), 400
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 409
        except FileNotFoundError as exc:
            return jsonify({"error": str(exc)}), 400
        except NotADirectoryError as exc:
            return jsonify({"error": str(exc)}), 400
        except OSError as exc:
            return jsonify({"error": f"Start fehlgeschlagen: {exc}"}), 500

        with state_lock:
            ui_state["phase"] = "ripping"

        return jsonify(_enrich_snapshot(snap, ui_state, state_lock)), 202

    @app.post("/api/stop")
    def stop() -> Any:
        with state_lock:
            scan_process = scan_runtime.get("process")
            scan_active = scan_process is not None and scan_process.poll() is None
            if scan_active:
                scan_runtime["cancel_requested"] = True
            elif scan_process is not None and scan_process.poll() is not None:
                scan_runtime["process"] = None

        if scan_active:
            assert scan_process is not None
            try:
                scan_process.terminate()
                scan_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                scan_process.kill()
                try:
                    scan_process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            finally:
                with state_lock:
                    ui_state["phase"] = "idle"
                    ui_state["scan_updated_at"] = _now_iso()
            return jsonify(_enriched_status_snapshot(runner, ui_state, state_lock))

        snap = runner.stop()
        with state_lock:
            if str(snap.get("state") or "") == "stopped":
                ui_state["phase"] = "stopped"
        return jsonify(_enrich_snapshot(snap, ui_state, state_lock))

    @app.post("/api/eject")
    def eject_drive() -> Any:
        if runner.snapshot()["is_running"]:
            return jsonify({"error": "Waehrend eines laufenden Rip-Jobs kann das Laufwerk nicht geoeffnet werden."}), 409

        payload = _json_payload()
        device_path = str(payload.get("device_path", "")).strip()

        if not device_path:
            profile_map = _coerce_device_profiles(payload.get("device_profiles"))
            detected = list_optical_drives(profile_map)
            if len(detected) == 1:
                device_path = str(detected[0].get("path") or "").strip()
            elif len(detected) > 1:
                return (
                    jsonify(
                        {
                            "error": (
                                "Mehrere Laufwerke erkannt. Bitte ein konkretes Laufwerk auswaehlen, "
                                "um inkonsistentes Auswerfen im Auto-Modus zu vermeiden."
                            )
                        }
                    ),
                    409,
                )

        command = ["eject"]
        if device_path:
            command.append(device_path)

        try:
            completed = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=15,
                check=False,
            )
        except FileNotFoundError:
            return jsonify({"error": "Das Kommando 'eject' wurde nicht gefunden."}), 400
        except PermissionError:
            return jsonify({"error": "Keine Berechtigung, um das Laufwerk auszuwerfen."}), 403
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Auswurf hat das Timeout erreicht."}), 504
        except OSError as exc:
            return jsonify({"error": f"Auswurf fehlgeschlagen: {exc}"}), 500

        normalized_output = _normalize_output(completed.stdout or "")
        payload_out = {
            "returncode": completed.returncode,
            "command": command,
            "output_preview": "\n".join(normalized_output.splitlines()[:40]),
        }

        if completed.returncode != 0:
            payload_out["error"] = f"Auswurf fehlgeschlagen (Exit-Code {completed.returncode})."
            return jsonify(payload_out), 422

        payload_out["message"] = "Laufwerk wurde geoeffnet."
        return jsonify(payload_out), 200

    @app.get("/api/status")
    def status() -> Any:
        since_raw = request.args.get("since", default=None)
        source_expected = str(request.args.get("source", default="auto") or "auto").strip().lower()
        since: int | None = None
        if since_raw is not None:
            try:
                since = int(since_raw)
            except ValueError:
                return jsonify({"error": "Query-Parameter 'since' muss eine Zahl sein."}), 400

        payload = status_payload()
        source = str(payload.get("log_source") or "scan")
        if source_expected in {"scan", "rip"} and source_expected != source:
            since = None
        if source == "scan":
            with state_lock:
                logs_meta = _scan_logs_snapshot(scan_runtime=scan_runtime, since=since)
        else:
            logs_meta = runner.logs(since=since)

        payload["logs"] = logs_meta.get("lines") or []
        payload["log_next_index"] = logs_meta.get("next_index")
        payload["log_oldest_index"] = logs_meta.get("oldest_index")
        return jsonify(payload)

    @app.get("/api/logs")
    def logs() -> Any:
        since_raw = request.args.get("since", default=None)
        source_raw = str(request.args.get("source", default="auto") or "auto").strip().lower()
        since: int | None = None
        if since_raw is not None:
            try:
                since = int(since_raw)
            except ValueError:
                return jsonify({"error": "Query-Parameter 'since' muss eine Zahl sein."}), 400

        if source_raw not in {"auto", "scan", "rip"}:
            return jsonify({"error": "Query-Parameter 'source' muss scan, rip oder auto sein."}), 400

        if source_raw == "rip":
            return jsonify(runner.logs(since=since))

        if source_raw == "scan":
            with state_lock:
                return jsonify(_scan_logs_snapshot(scan_runtime=scan_runtime, since=since))

        snap = runner.snapshot()
        with state_lock:
            scan_process = scan_runtime.get("process")
            scan_active = scan_process is not None and scan_process.poll() is None
            phase = str(ui_state.get("phase") or "")
            source = _determine_log_source(phase=phase, scan_active=scan_active, runner_snapshot=snap)

        if source == "scan":
            with state_lock:
                return jsonify(_scan_logs_snapshot(scan_runtime=scan_runtime, since=since))
        return jsonify(runner.logs(since=since))

    if sock is not None:
        @sock.route("/ws/status")
        def ws_status(ws: Any) -> None:
            scan_next_index: int | None = None
            rip_next_index: int | None = None

            try:
                while True:
                    payload = status_payload()
                    source = str(payload.get("log_source") or "scan")

                    if source == "scan":
                        since = scan_next_index if scan_next_index is not None else payload.get("log_oldest_index")
                        with state_lock:
                            logs_meta = _scan_logs_snapshot(scan_runtime=scan_runtime, since=since)
                        scan_next_index = int(logs_meta.get("next_index") or 0)
                    else:
                        since = rip_next_index if rip_next_index is not None else payload.get("log_oldest_index")
                        logs_meta = runner.logs(since=since)
                        rip_next_index = int(logs_meta.get("next_index") or 0)

                    ws.send(
                        json.dumps(
                            {
                                "type": "status",
                                "status": payload,
                                "logs": logs_meta.get("lines") or [],
                            },
                            ensure_ascii=True,
                        )
                    )
                    time.sleep(0.75)
            except (ConnectionError, OSError):
                return

        @sock.route("/ws/rpc")
        def ws_rpc(ws: Any) -> None:
            try:
                while True:
                    raw = ws.receive()
                    if raw is None:
                        return

                    try:
                        request_payload = json.loads(str(raw or "{}"))
                    except json.JSONDecodeError:
                        ws.send(json.dumps({"type": "rpc", "ok": False, "error": "Invalid JSON."}, ensure_ascii=True))
                        continue

                    response_payload = _dispatch_ws_rpc(app, request_payload)
                    ws.send(json.dumps(response_payload, ensure_ascii=True))
            except (ConnectionError, OSError):
                return

    return app


def _dispatch_ws_rpc(app: Flask, payload: dict[str, Any]) -> dict[str, Any]:
    request_id = payload.get("id") if isinstance(payload, dict) else None
    method = str(payload.get("method") or "GET").strip().upper() if isinstance(payload, dict) else "GET"
    raw_url = str(payload.get("url") or "").strip() if isinstance(payload, dict) else ""
    body = payload.get("body") if isinstance(payload, dict) else None

    parsed = urlparse(raw_url)
    path = parsed.path or raw_url.split("?", 1)[0]
    query_string = parsed.query

    if (method, path) not in _WS_RPC_ALLOWED:
        return {
            "type": "rpc",
            "id": request_id,
            "ok": False,
            "status": 404,
            "body": {"error": "WebSocket RPC route is not allowed."},
        }

    try:
        with app.test_request_context(path, method=method, query_string=query_string, json=body if method != "GET" else None):
            response = app.full_dispatch_request()
    except Exception as exc:  # pragma: no cover - mirrors Flask's HTTP error surface defensively
        app.logger.exception("WebSocket RPC failed")
        return {
            "type": "rpc",
            "id": request_id,
            "ok": False,
            "status": 500,
            "body": {"error": f"WebSocket RPC failed: {exc}"},
        }

    response_body = response.get_json(silent=True)
    if response_body is None:
        text = response.get_data(as_text=True)
        response_body = {"text": text} if text else {}

    return {
        "type": "rpc",
        "id": request_id,
        "ok": 200 <= response.status_code < 400,
        "status": response.status_code,
        "body": response_body,
    }


def _enriched_status_snapshot(runner: CyanripJobRunner, ui_state: dict[str, Any], lock: threading.RLock) -> dict[str, Any]:
    return _enrich_snapshot(runner.snapshot(), ui_state, lock)


def _enrich_snapshot(base_snapshot: dict[str, Any], ui_state: dict[str, Any], lock: threading.RLock) -> dict[str, Any]:
    merged = dict(base_snapshot)
    merged["session"] = _session_snapshot(ui_state, lock)
    merged["binary"] = _binary_probe_snapshot(ui_state, lock)
    return merged


def _session_snapshot(ui_state: dict[str, Any], lock: threading.RLock) -> dict[str, Any]:
    with lock:
        return {
            "id": ui_state.get("session_id"),
            "phase": ui_state.get("phase"),
            "scan_signature": ui_state.get("scan_signature"),
            "scan_updated_at": ui_state.get("scan_updated_at"),
        }


def _binary_probe_snapshot(ui_state: dict[str, Any], lock: threading.RLock) -> dict[str, Any]:
    with lock:
        probe = ui_state.get("binary_probe")
        if not isinstance(probe, dict):
            return {}
        return copy.deepcopy(probe)


def _refresh_binary_probe(ui_state: dict[str, Any], lock: threading.RLock, binary_path_raw: str) -> None:
    probe = _probe_binary_version(binary_path_raw)
    with lock:
        ui_state["binary_probe"] = probe


def _probe_binary_version(binary_path_raw: str) -> dict[str, Any]:
    checked_at = _now_iso()
    try:
        binary_path = _resolve_binary_path(binary_path_raw)
    except ValueError as exc:
        return {
            "ok": False,
            "binary_path": str(binary_path_raw or "").strip(),
            "version": "",
            "returncode": None,
            "error": str(exc),
            "checked_at": checked_at,
        }

    try:
        completed = subprocess.run(
            [binary_path, "-V"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=10,
            check=False,
        )
    except FileNotFoundError:
        return {
            "ok": False,
            "binary_path": binary_path,
            "version": "",
            "returncode": None,
            "error": f"Binary nicht gefunden: {binary_path}",
            "checked_at": checked_at,
        }
    except PermissionError:
        return {
            "ok": False,
            "binary_path": binary_path,
            "version": "",
            "returncode": None,
            "error": f"Keine Ausfuehrungsrechte: {binary_path}",
            "checked_at": checked_at,
        }
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "binary_path": binary_path,
            "version": "",
            "returncode": None,
            "error": "Probe-Command hat das Timeout erreicht.",
            "checked_at": checked_at,
        }
    except OSError as exc:
        return {
            "ok": False,
            "binary_path": binary_path,
            "version": "",
            "returncode": None,
            "error": f"Probe fehlgeschlagen: {exc}",
            "checked_at": checked_at,
        }

    version_output = (completed.stdout or "").strip()
    return {
        "ok": completed.returncode == 0,
        "binary_path": binary_path,
        "version": "\n".join(version_output.splitlines()[:2]),
        "returncode": completed.returncode,
        "error": "" if completed.returncode == 0 else f"Exit-Code {completed.returncode}",
        "checked_at": checked_at,
    }


def _determine_log_source(phase: str, scan_active: bool, runner_snapshot: dict[str, Any]) -> str:
    if scan_active or phase in {"scanning", "scan_error"}:
        return "scan"
    if phase in {"ripping", "finished", "failed", "stopped"}:
        return "rip"
    if runner_snapshot.get("is_running"):
        return "rip"
    return "scan"


def _reset_scan_runtime_logs(scan_runtime: dict[str, Any]) -> None:
    scan_runtime["log_lines"] = []
    scan_runtime["log_next_index"] = 0
    scan_runtime["last_command"] = []
    scan_runtime["last_shell_command"] = ""


def _append_scan_runtime_output(
    *,
    scan_runtime: dict[str, Any],
    state_lock: threading.RLock,
    raw_output: str,
) -> None:
    normalized = _normalize_output(raw_output or "")
    if not normalized:
        return

    rows = normalized.splitlines()
    if not rows:
        return

    with state_lock:
        lines = scan_runtime.setdefault("log_lines", [])
        next_idx = int(scan_runtime.get("log_next_index") or 0)
        for row in rows:
            if _is_noisy_progress_line(row):
                continue
            lines.append({"index": next_idx, "line": row})
            next_idx += 1
        if len(lines) > 6000:
            lines[:] = lines[-4500:]
        scan_runtime["log_next_index"] = next_idx


def _scan_logs_snapshot(*, scan_runtime: dict[str, Any], since: int | None) -> dict[str, Any]:
    lines_raw = scan_runtime.get("log_lines")
    lines: list[dict[str, Any]] = lines_raw if isinstance(lines_raw, list) else []
    next_index = int(scan_runtime.get("log_next_index") or 0)
    oldest_index = int(lines[0]["index"]) if lines else next_index
    since_index = max(oldest_index, since if since is not None else oldest_index)
    out_lines = [copy.deepcopy(entry) for entry in lines if int(entry.get("index", -1)) >= since_index]
    return {
        "lines": out_lines,
        "next_index": next_index,
        "oldest_index": oldest_index,
    }


def _run_disc_scan(
    binary_path: str,
    working_directory: str,
    config: dict[str, Any],
    *,
    state_lock: threading.RLock | None = None,
    scan_runtime: dict[str, Any] | None = None,
) -> dict[str, Any]:
    scan_config = _scan_config_from_user(config)
    result = CommandBuilder.build(binary_path=binary_path, config=scan_config)

    process: subprocess.Popen[str] | None = None
    output_chunks: list[str] = []
    returncode = 1
    cancel_requested = False
    start_time = time.monotonic()

    try:
        process = subprocess.Popen(
            result.argv,
            cwd=working_directory,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=_build_process_env(),
        )

        if state_lock is not None and scan_runtime is not None:
            with state_lock:
                scan_runtime["process"] = process
                scan_runtime["cancel_requested"] = False
                scan_runtime["last_command"] = list(result.argv)
                scan_runtime["last_shell_command"] = result.shell

        assert process.stdout is not None
        while True:
            if time.monotonic() - start_time > 1800:
                raise subprocess.TimeoutExpired(result.argv, timeout=1800)

            line = process.stdout.readline()
            if line:
                output_chunks.append(line)
                if state_lock is not None and scan_runtime is not None:
                    _append_scan_runtime_output(scan_runtime=scan_runtime, state_lock=state_lock, raw_output=line)
                continue

            if process.poll() is not None:
                tail = process.stdout.read()
                if tail:
                    output_chunks.append(tail)
                    if state_lock is not None and scan_runtime is not None:
                        _append_scan_runtime_output(scan_runtime=scan_runtime, state_lock=state_lock, raw_output=tail)
                break

            time.sleep(0.04)

        returncode = process.wait(timeout=8)
    except FileNotFoundError:
        raise ValueError(f"Binary nicht gefunden: {binary_path}") from None
    except PermissionError:
        raise ValueError(f"Keine Ausfuehrungsrechte: {binary_path}") from None
    except subprocess.TimeoutExpired:
        if process is not None:
            process.kill()
            if process.stdout is not None:
                tail = process.stdout.read()
                if tail:
                    output_chunks.append(tail)
                    if state_lock is not None and scan_runtime is not None:
                        _append_scan_runtime_output(scan_runtime=scan_runtime, state_lock=state_lock, raw_output=tail)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        if state_lock is not None and scan_runtime is not None:
            with state_lock:
                if scan_runtime.get("process") is process:
                    scan_runtime["process"] = None
        return {
            "returncode": 124,
            "command": result.argv,
            "shell_command": result.shell,
            "parsed": {"disc": {}, "tracks": []},
            "output_lines": 0,
            "output_preview": "",
            "error": "CD-Scan hat das Timeout erreicht.",
            "cancelled": False,
        }
    finally:
        if state_lock is not None and scan_runtime is not None:
            with state_lock:
                cancel_requested = bool(scan_runtime.get("cancel_requested"))
                if scan_runtime.get("process") is process:
                    scan_runtime["process"] = None

    normalized_output = _normalize_output("".join(output_chunks))
    parsed = parse_scan_output(normalized_output)
    release_candidates = _extract_release_candidates(normalized_output)
    release_options = _extract_release_options(normalized_output)
    if release_options and not release_candidates:
        release_candidates = [str(item.get("id") or "").strip().lower() for item in release_options if item.get("id")]
    musicbrainz_submission_url = _extract_musicbrainz_submission_url(normalized_output)
    error_kind = _classify_scan_error(
        raw_output=normalized_output,
        release_candidates=release_candidates,
        release_options=release_options,
        musicbrainz_submission_url=musicbrainz_submission_url,
    )

    cancelled = cancel_requested or returncode in (-15, -9, 143, 137)
    error_message = _build_scan_error_message(
        cancelled=cancelled,
        returncode=returncode,
        raw_output=normalized_output,
        release_candidates=release_candidates,
        release_options=release_options,
        error_kind=error_kind,
    )

    return {
        "returncode": returncode,
        "command": result.argv,
        "shell_command": result.shell,
        "parsed": parsed,
        "output_lines": len(normalized_output.splitlines()),
        "output_preview": "\n".join(normalized_output.splitlines()[:120]),
        "error": error_message,
        "cancelled": cancelled,
        "release_candidates": release_candidates,
        "release_options": release_options,
        "error_kind": error_kind,
        "musicbrainz_submission_url": musicbrainz_submission_url,
    }


def _scan_config_from_user(config: dict[str, Any]) -> dict[str, Any]:
    user_config = dict(config or {})
    scan_config: dict[str, Any] = {
        "device_path": user_config.get("device_path"),
        "offset": user_config.get("offset"),
        "find_drive_offset": bool(user_config.get("find_drive_offset")),
        "disable_mb": bool(user_config.get("disable_mb")),
        "disable_accurip": bool(user_config.get("disable_accurip")),
        "disable_coverart_db": bool(user_config.get("disable_coverart_db")),
        "coverart_lookup_size": None,
        "disable_coverart_embedding": False,
        "print_info_only": True,
        "show_help": False,
        "print_version": False,
        "track_selection": [],
        "outputs": [],
        "bitrate": None,
        "directory_scheme": "",
        "track_scheme": "",
        "log_scheme": "",
        "cue_scheme": "",
        "album_metadata": "",
        "track_metadata": [],
        "release": str(user_config.get("release") or "").strip(),
        "disc_number": None,
        "total_discs": None,
        "cover_arts": [],
        "max_retries": None,
        "ripping_retries": None,
        "speed": None,
        "pregap_rules": [],
        "paranoia_level": None,
        "overread_leadinout": False,
        "decode_hdcd": False,
        "force_deemphasis": False,
        "disable_deemphasis": False,
        "disable_replaygain": False,
        "eject_on_success": False,
        "sanitation": None,
    }
    return scan_config


def _extract_release_candidates(raw_output: str) -> list[str]:
    text = str(raw_output or "")
    lines = text.splitlines()
    has_hint = any(_MULTI_RELEASE_HINT_RE.search(line) for line in lines)

    candidates: list[str] = []
    seen: set[str] = set()

    def add_candidate(value: str) -> None:
        normalized = str(value or "").strip().lower()
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        candidates.append(normalized)

    for line in lines:
        if not (_MULTI_RELEASE_HINT_RE.search(line) or _MB_RELEASE_ID_RE.search(line)):
            continue
        for match in _MB_RELEASE_ID_RE.findall(line):
            add_candidate(match)

    if candidates:
        return candidates

    if not has_hint:
        return []

    for match in _MB_RELEASE_ID_RE.findall(text):
        add_candidate(match)
    return candidates


def _extract_release_options(raw_output: str) -> list[dict[str, str]]:
    text = str(raw_output or "")
    out: list[dict[str, str]] = []
    seen_ids: set[str] = set()

    for raw_line in text.splitlines():
        match = _MB_RELEASE_OPTION_RE.match(raw_line)
        if not match:
            continue
        release_id = str(match.group(1) or "").strip().lower()
        description = str(match.group(2) or "").strip()
        if not release_id or release_id in seen_ids:
            continue
        seen_ids.add(release_id)
        out.append(
            {
                "id": release_id,
                "label": f"{description} ({release_id})" if description else release_id,
            }
        )
    return out


def _extract_musicbrainz_submission_url(raw_output: str) -> str:
    match = _MB_CD_TOC_ATTACH_RE.search(str(raw_output or ""))
    return match.group(0).strip() if match else ""


def _classify_scan_error(
    *,
    raw_output: str,
    release_candidates: list[str],
    release_options: list[dict[str, str]],
    musicbrainz_submission_url: str,
) -> str | None:
    if release_candidates or release_options:
        return "release_selection_required"

    text = str(raw_output or "")
    if musicbrainz_submission_url and _NO_RELEASE_HINT_RE.search(text):
        return "no_release_found"

    return None


def _build_scan_error_message(
    *,
    cancelled: bool,
    returncode: int,
    raw_output: str,
    release_candidates: list[str],
    release_options: list[dict[str, str]],
    error_kind: str | None = None,
) -> str | None:
    if cancelled:
        return "CD-Scan wurde abgebrochen."
    if returncode == 0:
        return None
    if error_kind == "release_selection_required" or release_candidates or release_options:
        return (
            "Mehrere Releases fuer diese Disc-ID gefunden. "
            "Bitte eine Release-ID auswaehlen und den Scan erneut starten."
        )
    if error_kind == "no_release_found":
        return (
            "Keine MusicBrainz-Release-Information fuer diese Disc gefunden. "
            "Bitte Disc-ID bei MusicBrainz eintragen, erneut scannen oder ohne MusicBrainz fortfahren."
        )

    lines = [line.strip() for line in str(raw_output or "").splitlines() if line.strip()]
    for line in reversed(lines[-40:]):
        lowered = line.lower()
        if lowered.startswith("error") or "fehl" in lowered:
            return line

    return f"CD-Scan fehlgeschlagen (Exit-Code {returncode})."


def _effective_settings(raw_settings: dict[str, Any] | None) -> dict[str, Any]:
    raw = raw_settings if isinstance(raw_settings, dict) else {}
    merged = copy.deepcopy(DEFAULT_UI_SETTINGS)

    binary_path = str(raw.get("binary_path") or "").strip()
    if binary_path:
        merged["binary_path"] = binary_path

    workdir = str(raw.get("working_directory") or "").strip()
    if workdir:
        merged["working_directory"] = workdir

    language = str(raw.get("language") or "").strip().lower()
    if language in {"en", "de"}:
        merged["language"] = language

    merged["misc_offset"] = _parse_optional_int(raw.get("misc_offset"), fallback=0)
    merged["device_profiles"] = _coerce_device_profiles(raw.get("device_profiles"))
    return merged


def _coerce_device_profiles(value: Any) -> dict[str, dict[str, int]]:
    if not isinstance(value, dict):
        return {}
    out: dict[str, dict[str, int]] = {}
    for raw_key, raw_payload in value.items():
        key = str(raw_key or "").strip()
        if not key or not isinstance(raw_payload, dict):
            continue
        offset_value = raw_payload.get("offset")
        if offset_value in (None, ""):
            continue
        try:
            offset = int(str(offset_value).strip())
        except (TypeError, ValueError):
            continue
        out[key] = {"offset": offset}
    return out


def _parse_optional_int(value: Any, *, fallback: int) -> int:
    if value in (None, ""):
        return fallback
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return fallback


def _read_profile_map_from_request() -> dict[str, dict[str, int]]:
    raw_profiles = request.args.get("profiles", default="", type=str).strip()
    if not raw_profiles:
        return {}
    try:
        payload = json.loads(raw_profiles)
    except json.JSONDecodeError:
        return {}
    return _coerce_device_profiles(payload)


def _ensure_runtime_directories() -> None:
    global APP_DATA_ROOT, DEFAULT_WORKING_DIRECTORY

    candidates = [DEFAULT_WORKING_DIRECTORY]
    if APP_IS_FROZEN:
        tmp_workdir = Path(os.environ.get("TMPDIR") or "/tmp") / "cyanrip-webui" / "output"
        if tmp_workdir not in candidates:
            candidates.append(tmp_workdir)

    last_error: OSError | None = None
    for workdir in candidates:
        try:
            workdir.mkdir(parents=True, exist_ok=True)
            _ensure_directory_writable(workdir)
        except OSError as exc:
            last_error = exc
            continue

        APP_DATA_ROOT = workdir.parent
        DEFAULT_WORKING_DIRECTORY = workdir
        if APP_IS_FROZEN:
            DEFAULT_UI_SETTINGS["working_directory"] = str(DEFAULT_WORKING_DIRECTORY)
        return

    if last_error is not None:
        raise last_error


def _ensure_directory_writable(path: Path) -> None:
    probe = path / f".cyanrip-webui-write-test-{os.getpid()}"
    try:
        probe.write_text("", encoding="utf-8")
    finally:
        try:
            probe.unlink(missing_ok=True)
        except OSError:
            pass


def _disc_signature(disc: dict[str, Any]) -> str:
    fields = [
        str(disc.get("discid") or "").strip(),
        str(disc.get("release_id") or "").strip(),
        str(disc.get("cddb_id") or "").strip(),
        str(disc.get("disc_mcn") or "").strip(),
        str(disc.get("disc_tracks") or "").strip(),
        str(disc.get("total_time") or "").strip(),
    ]

    compact = [value for value in fields if value]
    if compact:
        return "|".join(compact)

    fallback = [
        str(disc.get("album") or "").strip(),
        str(disc.get("album_artist") or "").strip(),
        str(disc.get("total_time") or "").strip(),
    ]
    return "|".join(fallback)


def _new_session_id() -> str:
    return uuid.uuid4().hex[:12]


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _json_payload() -> dict[str, Any]:
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


def _normalize_output(raw_output: str) -> str:
    # cyanrip writes progress updates with carriage returns; normalize those for parsing/UI.
    return raw_output.replace("\r", "\n")


def _is_noisy_progress_line(line: str) -> bool:
    text = str(line or "").strip()
    if not text:
        return True
    return bool(_RIP_PROGRESS_LINE_RE.match(text))


def _build_process_env() -> dict[str, str]:
    return os.environ.copy()


def _fetch_remote_cover(
    *,
    raw_url: str,
    cache: dict[str, dict[str, Any]],
    lock: threading.RLock,
) -> tuple[bytes, str]:
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Cover-URL muss mit http:// oder https:// beginnen.")

    now = time.time()
    with lock:
        cached = cache.get(raw_url)
        if cached and float(cached.get("expires_at") or 0.0) > now:
            cached_data = cached.get("data")
            cached_mime = str(cached.get("mime") or "")
            if isinstance(cached_data, (bytes, bytearray)) and cached_mime.startswith("image/"):
                return bytes(cached_data), cached_mime
        elif cached:
            cache.pop(raw_url, None)

    request = Request(
        raw_url,
        headers={
            "User-Agent": "cyanrip-webui/1.0 (+cover-proxy)",
            "Accept": "image/*,*/*;q=0.8",
            "Connection": "close",
        },
    )

    last_error = "Cover konnte nicht geladen werden."
    for attempt in range(1, 5):
        try:
            with urlopen(request, timeout=18) as response:
                body = response.read(COVER_FETCH_MAX_BYTES + 1)
                if len(body) > COVER_FETCH_MAX_BYTES:
                    raise ValueError("Cover-Datei ist zu gross fuer die Vorschau.")

                content_type = str(response.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
                mime = _resolve_cover_mime(content_type, raw_url)
                if not mime.startswith("image/"):
                    raise ValueError("Cover-URL liefert kein Bildformat.")

                with lock:
                    _cleanup_cover_cache(cache)
                    cache[raw_url] = {
                        "data": bytes(body),
                        "mime": mime,
                        "expires_at": time.time() + COVER_CACHE_TTL_SECONDS,
                    }
                return bytes(body), mime
        except ValueError:
            raise
        except HTTPError as exc:
            last_error = f"Cover-URL lieferte HTTP {exc.code}."
        except URLError as exc:
            last_error = f"Cover-URL konnte nicht erreicht werden: {exc.reason}."
        except OSError as exc:
            last_error = f"Cover-Download fehlgeschlagen: {exc}."

        if attempt < 4:
            time.sleep(0.4 * attempt)

    raise OSError(last_error)


def _resolve_cover_mime(content_type: str, raw_url: str) -> str:
    normalized = str(content_type or "").strip().lower()
    if normalized.startswith("image/"):
        return normalized

    guessed, _ = mimetypes.guess_type(raw_url)
    if guessed and guessed.startswith("image/"):
        return guessed
    return normalized or "application/octet-stream"


def _cleanup_cover_cache(cache: dict[str, dict[str, Any]]) -> None:
    now = time.time()
    expired = [url for url, payload in cache.items() if float(payload.get("expires_at") or 0.0) <= now]
    for url in expired:
        cache.pop(url, None)

    if len(cache) <= COVER_CACHE_MAX_ITEMS:
        return

    sorted_urls = sorted(cache.items(), key=lambda item: float(item[1].get("expires_at") or 0.0))
    overflow = len(cache) - COVER_CACHE_MAX_ITEMS
    for url, _ in sorted_urls[:overflow]:
        cache.pop(url, None)


def _list_directories(raw_path: str) -> dict[str, Any]:
    target = _resolve_directory_for_browse(raw_path)
    if not target.is_dir():
        raise ValueError(f"Kein Verzeichnis: {target}")

    try:
        entries = list(target.iterdir())
    except PermissionError as exc:
        raise PermissionError(f"Kein Zugriff auf Verzeichnis: {target}") from exc

    directories: list[dict[str, Any]] = []
    for entry in sorted(entries, key=lambda item: item.name.lower()):
        if not entry.is_dir():
            continue
        directories.append(
            {
                "name": entry.name,
                "path": str(entry),
                "hidden": entry.name.startswith("."),
            }
        )

    parent = target.parent if target.parent != target else None
    return {
        "path": str(target),
        "parent": str(parent) if parent is not None else None,
        "home": str(Path.home()),
        "project_root": str(APP_DATA_ROOT),
        "directories": directories,
    }


def _resolve_directory_for_browse(raw_path: str) -> Path:
    candidate_raw = str(raw_path or "").strip()
    if not candidate_raw:
        return Path.home().resolve()

    candidate = Path(candidate_raw).expanduser()
    if not candidate.is_absolute():
        candidate = (APP_DATA_ROOT / candidate).resolve()
    else:
        candidate = candidate.resolve()

    if candidate.exists() and candidate.is_dir():
        return candidate

    if candidate.exists() and not candidate.is_dir():
        parent = candidate.parent
        if parent.exists() and parent.is_dir():
            return parent
        raise ValueError(f"Pfad ist kein Verzeichnis: {candidate}")

    parent = candidate.parent
    while parent != parent.parent and not parent.exists():
        parent = parent.parent

    if parent.exists() and parent.is_dir():
        return parent.resolve()

    raise ValueError(f"Ungueltiger Verzeichnispfad: {candidate}")


def _resolve_working_directory(raw_value: str) -> str:
    user_value = (raw_value or "").strip()
    workdir = Path(user_value).expanduser() if user_value else DEFAULT_WORKING_DIRECTORY
    if not workdir.is_absolute():
        workdir = (APP_DATA_ROOT / workdir).resolve()
    else:
        workdir = workdir.resolve()

    if workdir.exists() and not workdir.is_dir():
        raise ValueError(f"Arbeitsverzeichnis ist keine Directory: {workdir}")

    workdir.mkdir(parents=True, exist_ok=True)
    return str(workdir)


def _resolve_binary_path(raw_value: str) -> str:
    value = (raw_value or "").strip()
    if not value:
        raise ValueError("Pfad zur cyanrip-Binary fehlt.")

    if APP_IS_FROZEN and value in {"./bin/cyanrip", "bin/cyanrip"} and DEFAULT_BINARY_PATH != "./bin/cyanrip":
        return DEFAULT_BINARY_PATH

    candidate = Path(value).expanduser()
    if candidate.is_absolute():
        return str(candidate)

    has_separator = any(sep and sep in value for sep in (os.sep, os.altsep))
    if has_separator or value.startswith(".") or value.startswith("~"):
        base = Path.cwd() if APP_IS_FROZEN else PROJECT_ROOT
        return str((base / candidate).resolve())

    # Bare command name, let PATH resolution handle it (e.g. "cyanrip").
    return value
