# cyanrip-webui

`cyanrip-webui` is a Linux-first Web UI for `cyanrip`.
It does not modify cyanrip itself; it only controls the cyanrip CLI process and visualizes scan/rip status.

## Goals

- No changes to cyanrip source code (`cyanrip-src/...` is read-only reference material)
- Loose coupling: Web UI talks to cyanrip only through CLI args and process output
- Minimal dependencies (Flask + Python stdlib)
- Full cyanrip CLI flag coverage
- Beginner-friendly hints with expert CLI notes
- Disc scan before ripping, including track table and metadata
- Track-level live progress and final status/AccurateRip info
- Theme auto-detection (light/dark) with manual override
- English as default language, with locale files and browser language detection

## Project Layout

- `app.py`: Flask entrypoint
- `webui/app_factory.py`: routes and API endpoints
- `webui/command_builder.py`: UI config -> cyanrip args
- `webui/runner.py`: background process runner and live logs
- `webui/scan_parser.py`: parser for scan/rip output
- `webui/templates/index.html`: single-page UI
- `webui/static/style.css`, `webui/static/app.js`: frontend
- `webui/static/i18n/*.json`: language files
- `tests/*.py`: unit tests

## Quick Start

1. Create and activate a Python venv.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Provide a cyanrip binary, for example:

```bash
mkdir -p bin
cp /usr/bin/cyanrip ./bin/cyanrip
chmod +x ./bin/cyanrip
```

3. Start the web UI:

```bash
python3 app.py
```

4. Open: `http://127.0.0.1:8080`

## API Endpoints

- `POST /api/preview`: build command preview from UI config
- `POST /api/start`: start rip job
- `POST /api/scan`: scan disc via `cyanrip -I`
- `POST /api/stop`: stop running job
- `POST /api/eject`: open CD drive tray via `eject`
- `GET /api/status`: job status snapshot
- `GET /api/logs?since=<index>`: incremental logs
- `POST /api/probe`: run `-V` and `-h` against the selected binary

## Notes

- `working_directory` defaults to `./output`.
- Multi-entry args (`-t`, `-p`, `-C`) are mapped via line-based UI inputs.
- Current target platform is Linux.

## Tests

```bash
python3 -m unittest discover -s tests
```
