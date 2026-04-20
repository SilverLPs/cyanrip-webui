from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request

from .command_builder import (
    COVERART_LOOKUP_SIZES,
    DEFAULT_CONFIG,
    PREGAP_ACTIONS,
    SANITATION_MODES,
    SUPPORTED_OUTPUTS,
    CommandBuilder,
    CommandBuilderError,
)
from .runner import CyanripJobRunner
from .scan_parser import parse_scan_output

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WORKING_DIRECTORY = PROJECT_ROOT / "output"


def create_app() -> Flask:
    app = Flask(__name__)
    runner = CyanripJobRunner()
    DEFAULT_WORKING_DIRECTORY.mkdir(parents=True, exist_ok=True)

    @app.get("/")
    def index() -> str:
        return render_template(
            "index.html",
            default_config=DEFAULT_CONFIG,
            supported_outputs=SUPPORTED_OUTPUTS,
            sanitation_modes=SANITATION_MODES,
            pregap_actions=PREGAP_ACTIONS,
            coverart_lookup_sizes=COVERART_LOOKUP_SIZES,
            default_working_directory="./output",
        )

    @app.post("/api/preview")
    def preview() -> Any:
        payload = _json_payload()
        binary_path_raw = str(payload.get("binary_path", "")).strip()
        config = payload.get("config") or {}

        try:
            binary_path = _resolve_binary_path(binary_path_raw)
            result = CommandBuilder.build(binary_path=binary_path, config=config)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except CommandBuilderError as exc:
            return jsonify({"error": str(exc)}), 400

        return jsonify({"command": result.argv, "shell_command": result.shell})

    @app.post("/api/start")
    def start() -> Any:
        payload = _json_payload()
        binary_path_raw = str(payload.get("binary_path", "")).strip()
        working_directory_raw = str(payload.get("working_directory", "")).strip()
        config = payload.get("config") or {}

        try:
            working_directory = _resolve_working_directory(working_directory_raw)
            binary_path = _resolve_binary_path(binary_path_raw)
            result = CommandBuilder.build(binary_path=binary_path, config=config)
            snap = runner.start(
                command=result.argv,
                shell_command=result.shell,
                working_directory=working_directory,
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
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

        return jsonify(snap), 202

    @app.post("/api/scan")
    def scan() -> Any:
        if runner.snapshot()["is_running"]:
            return jsonify({"error": "Ein Rip-Job laeuft bereits. Bitte zuerst stoppen oder warten."}), 409

        payload = _json_payload()
        binary_path_raw = str(payload.get("binary_path", "")).strip()
        working_directory_raw = str(payload.get("working_directory", "")).strip()
        config = payload.get("config") or {}

        scan_config = dict(config)
        scan_config["print_info_only"] = True
        scan_config["show_help"] = False
        scan_config["print_version"] = False
        scan_config["find_drive_offset"] = False
        scan_config["outputs"] = ["flac"]
        scan_config["directory_scheme"] = DEFAULT_CONFIG["directory_scheme"]
        scan_config["track_scheme"] = DEFAULT_CONFIG["track_scheme"]
        scan_config["log_scheme"] = DEFAULT_CONFIG["log_scheme"]
        scan_config["cue_scheme"] = DEFAULT_CONFIG["cue_scheme"]

        try:
            working_directory = _resolve_working_directory(working_directory_raw)
            binary_path = _resolve_binary_path(binary_path_raw)
            result = CommandBuilder.build(binary_path=binary_path, config=scan_config)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except CommandBuilderError as exc:
            return jsonify({"error": str(exc)}), 400

        try:
            completed = subprocess.run(
                result.argv,
                cwd=working_directory,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=1800,
                check=False,
                env=_build_process_env(),
            )
        except FileNotFoundError:
            return jsonify({"error": f"Binary nicht gefunden: {binary_path}"}), 400
        except PermissionError:
            return jsonify({"error": f"Keine Ausfuehrungsrechte: {binary_path}"}), 400
        except subprocess.TimeoutExpired:
            return jsonify({"error": "CD-Scan hat das Timeout erreicht."}), 504
        except OSError as exc:
            return jsonify({"error": f"CD-Scan fehlgeschlagen: {exc}"}), 500

        normalized_output = _normalize_output(completed.stdout or "")
        parsed = parse_scan_output(normalized_output)
        payload_out: dict[str, Any] = {
            "returncode": completed.returncode,
            "command": result.argv,
            "shell_command": result.shell,
            "disc": parsed["disc"],
            "tracks": parsed["tracks"],
            "output_lines": len(normalized_output.splitlines()),
            "output_preview": "\n".join(normalized_output.splitlines()[:120]),
        }

        if completed.returncode != 0:
            payload_out["error"] = f"CD-Scan fehlgeschlagen (Exit-Code {completed.returncode})."
            runner.update_scan_result(
                parsed["disc"],
                parsed["tracks"],
                returncode=completed.returncode,
                error=payload_out["error"],
            )
            return jsonify(payload_out), 422

        runner.update_scan_result(parsed["disc"], parsed["tracks"], returncode=completed.returncode)
        return jsonify(payload_out), 200

    @app.post("/api/stop")
    def stop() -> Any:
        return jsonify(runner.stop())

    @app.post("/api/eject")
    def eject_drive() -> Any:
        if runner.snapshot()["is_running"]:
            return jsonify({"error": "Waehrend eines laufenden Rip-Jobs kann das Laufwerk nicht geoeffnet werden."}), 409

        payload = _json_payload()
        device_path = str(payload.get("device_path", "")).strip()

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
        return jsonify(runner.snapshot())

    @app.get("/api/logs")
    def logs() -> Any:
        since_raw = request.args.get("since", default=None)
        since: int | None = None
        if since_raw is not None:
            try:
                since = int(since_raw)
            except ValueError:
                return jsonify({"error": "Query-Parameter 'since' muss eine Zahl sein."}), 400

        return jsonify(runner.logs(since=since))

    @app.post("/api/probe")
    def probe() -> Any:
        payload = _json_payload()
        binary_path_raw = str(payload.get("binary_path", "")).strip()

        try:
            binary_path = _resolve_binary_path(binary_path_raw)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        try:
            version = subprocess.run(
                [binary_path, "-V"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=10,
                check=False,
            )
            help_out = subprocess.run(
                [binary_path, "-h"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=10,
                check=False,
            )
        except FileNotFoundError:
            return jsonify({"error": f"Binary nicht gefunden: {binary_path}"}), 400
        except PermissionError:
            return jsonify({"error": f"Keine Ausfuehrungsrechte: {binary_path}"}), 400
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Probe-Command hat das Timeout erreicht."}), 504
        except OSError as exc:
            return jsonify({"error": f"Probe fehlgeschlagen: {exc}"}), 500

        version_output = (version.stdout or "").strip()
        help_output = (help_out.stdout or "").strip()

        return jsonify(
            {
                "version_returncode": version.returncode,
                "help_returncode": help_out.returncode,
                "version_output": version_output,
                "help_preview": "\n".join(help_output.splitlines()[:12]),
            }
        )

    return app


def _json_payload() -> dict[str, Any]:
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


def _normalize_output(raw_output: str) -> str:
    # cyanrip writes progress updates with carriage returns; normalize those for parsing/UI.
    return raw_output.replace("\r", "\n")


def _build_process_env() -> dict[str, str]:
    return os.environ.copy()


def _resolve_working_directory(raw_value: str) -> str:
    user_value = (raw_value or "").strip()
    workdir = Path(user_value).expanduser() if user_value else DEFAULT_WORKING_DIRECTORY
    if not workdir.is_absolute():
        workdir = (PROJECT_ROOT / workdir).resolve()
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

    candidate = Path(value).expanduser()
    if candidate.is_absolute():
        return str(candidate)

    has_separator = any(sep and sep in value for sep in (os.sep, os.altsep))
    if has_separator or value.startswith(".") or value.startswith("~"):
        return str((PROJECT_ROOT / candidate).resolve())

    # Bare command name, let PATH resolution handle it (e.g. "cyanrip").
    return value
