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
- Phase-based workflow (pre-scan -> review/setup -> post-rip) with disc change detection before rip start
- Internal session IDs for lifecycle boundaries and future multi-session extensibility (not shown in main UI)
- Global settings persisted in app storage (binary path, working directory, language, per-drive offsets, auto/path fallback offset)
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
- `POST /api/stop`: stop running scan or rip job
- `POST /api/eject`: open CD drive tray via `eject`
- `GET /api/status`: job status snapshot
- `GET /api/logs?source=<auto|scan|rip>&since=<index>`: incremental logs (phase-aware by default with `source=auto`)
- `GET /api/cover?path=<file>`: serve scanned cover image previews from backend filesystem
- `GET /api/settings`: load persisted global settings + binary probe status
- `POST /api/settings`: persist global settings
- `POST /api/probe`: run `-V` against the selected binary
- `GET /api/drives`: list detected optical drives (with saved offset hints)
- `POST /api/drives/offset`: persist per-drive offset
- `POST /api/session/reset`: return to pre-scan phase and clear cached scan metadata
- `GET /api/fs/directories?path=<dir>`: server-side directory browser for settings/output pickers

## Notes

- `working_directory` defaults to `./output`.
- The web UI uses user-facing workflow phases; backend still keeps technical session phases and IDs for state tracking.
- Directory selection in the UI is server-side (backend filesystem, not browser client filesystem).
- Multi-entry args (`-p`, `-C`) are mapped via line-based UI inputs; track metadata (`-t`) is built from edited rows in the track table.
- Persisted settings file: `./output/.cyanrip-webui-settings.json`
- Current target platform is Linux.

## Tests

```bash
python3 -m unittest discover -s tests
```
