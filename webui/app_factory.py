from __future__ import annotations

import subprocess
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


def create_app() -> Flask:
    app = Flask(__name__)
    runner = CyanripJobRunner()

    @app.get("/")
    def index() -> str:
        return render_template(
            "index.html",
            default_config=DEFAULT_CONFIG,
            supported_outputs=SUPPORTED_OUTPUTS,
            sanitation_modes=SANITATION_MODES,
            pregap_actions=PREGAP_ACTIONS,
            coverart_lookup_sizes=COVERART_LOOKUP_SIZES,
        )

    @app.post("/api/preview")
    def preview() -> Any:
        payload = _json_payload()
        binary_path = str(payload.get("binary_path", "")).strip()
        config = payload.get("config") or {}

        try:
            result = CommandBuilder.build(binary_path=binary_path, config=config)
        except CommandBuilderError as exc:
            return jsonify({"error": str(exc)}), 400

        return jsonify({"command": result.argv, "shell_command": result.shell})

    @app.post("/api/start")
    def start() -> Any:
        payload = _json_payload()
        binary_path = str(payload.get("binary_path", "")).strip()
        working_directory = str(payload.get("working_directory", "")).strip() or None
        config = payload.get("config") or {}

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

        return jsonify(snap), 202

    @app.post("/api/stop")
    def stop() -> Any:
        return jsonify(runner.stop())

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
        binary_path = str(payload.get("binary_path", "")).strip()
        if not binary_path:
            return jsonify({"error": "Pfad zur cyanrip-Binary fehlt."}), 400

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
