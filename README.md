# cyanrip-webui

`cyanrip-webui` is a Linux-first Web UI for `cyanrip`.
It does not modify cyanrip itself; it only controls the cyanrip CLI process and visualizes scan/rip status.

## Goals

- No changes to cyanrip source code (`cyanrip-src/...` is read-only reference material)
- Loose coupling: Web UI talks to cyanrip only through CLI args and process output
- Backend remains stateless for user preferences (settings live in browser storage)
- Full cyanrip CLI flag coverage
- Beginner-friendly hints with expert CLI notes
- Disc scan before ripping, including track table and metadata
- Track-level live progress and final status/AccurateRip info
- Phase-based workflow (pre-scan -> review/setup -> post-rip) with disc change detection before rip start
- Internal session IDs for lifecycle boundaries and future multi-session extensibility (not shown in main UI)
- Global runtime settings persisted in browser storage (binary path, working directory, language, per-drive offsets)
- Theme auto-detection (light/dark) with manual override
- English as default language, with locale files and browser language detection
- WebSocket-first status/log streaming with optional HTTP polling fallback
- WebSocket RPC for frontend/backend JSON actions; HTTP fallback is opt-in for debugging only

## Project Layout

- `app.py`: Flask entrypoint
- `launcher.py`: optional desktop/headless launcher with tray support
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

Enable verbose Flask debug logs only when needed:

```bash
python3 app.py --debug
```

Allow HTTP fallback if WebSocket transport is unavailable:

```bash
python3 app.py --enable-http-fallback
```

Alternative launcher (tray/headless aware):

```bash
python3 launcher.py
```

Optional browser auto-open:

```bash
python3 launcher.py --open-browser
```

The launcher supports the same fallback switch:

```bash
python3 launcher.py --enable-http-fallback
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
- `WS /ws/status`: status + incremental logs stream
- `WS /ws/rpc`: JSON RPC transport for API-style frontend/backend actions
- `GET /api/cover?path=<file>`: serve scanned cover image previews from backend filesystem
- `GET /api/settings`: load backend defaults + binary probe status (+ websocket capability)
- `POST /api/settings`: stateless normalization/probe helper (does not persist server-side)
- `POST /api/probe`: run `-V` against the selected binary
- `GET /api/drives`: list detected optical drives (profile hints can be passed from frontend state)
- `POST /api/drives/offset`: stateless profile merge helper (no backend persistence)
- `POST /api/session/reset`: return to pre-scan phase and clear cached scan metadata
- `GET /api/fs/directories?path=<dir>`: server-side directory browser for settings/output pickers

## Notes

- `working_directory` defaults to `./output` during source-tree runs.
- In AppImage builds, the default output directory is `output` next to the AppImage file.
- AppImage builds bundle `bin/cyanrip` and use that binary by default; users can still point the setting at another cyanrip executable.
- The web UI uses user-facing workflow phases; backend still keeps technical session phases and IDs for state tracking.
- Directory selection in the UI is server-side (backend filesystem, not browser client filesystem).
- Multi-entry args (`-p`, `-C`) are mapped via line-based UI inputs; track metadata (`-t`) is built from edited rows in the track table.
- Multi-release DiscID scan errors are surfaced in UI with release ID selection, not only in logs.
- Missing MusicBrainz release info is surfaced with the MusicBrainz DiscID submission URL and an option to rescan without MusicBrainz.
- HTTP remains necessary for the initial HTML/static assets, locale files, cover image previews, and the first settings/capability request. Normal JSON actions use WebSocket RPC after that. HTTP fallback for these actions is disabled by default and can be enabled with `--enable-http-fallback`.
- Current target platform is Linux.

## Packaging (AppImage)

Build script:

```bash
./scripts/build_appimage.sh
```

Output:

- `dist/cyanrip-webui-x86_64.AppImage`

Runtime notes:

- AppImage entrypoint is `launcher.py` (backend + optional tray integration).
- The launcher prefers Qt's native system tray integration. Legacy XEmbed/pystray can be enabled with `CYANRIP_WEBUI_ALLOW_XEMBED_TRAY=1` for debugging, but it is not the default because it has limited menu support.
- Use `--headless` to force non-GUI/background behavior on desktop systems.
- Browser auto-open is disabled by default; use `--open-browser` if desired.

## Tests

```bash
python3 -m unittest discover -s tests
```
