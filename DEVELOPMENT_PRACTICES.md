# Development Practices

This document keeps development and packaging details out of the user-facing README.

## Architecture

- `app.py`: Flask development entrypoint
- `launcher.py`: desktop/headless launcher with Qt system tray integration
- `webui/app_factory.py`: Flask routes, WebSocket RPC, scan helpers, cover proxy/upload
- `webui/command_builder.py`: UI configuration to cyanrip CLI arguments
- `webui/runner.py`: background cyanrip process runner, log parsing, runtime status
- `webui/scan_parser.py`: cyanrip scan/rip output parser
- `webui/templates/index.html`: single-page UI
- `webui/static/app.js`: frontend state, WebSocket RPC, workflow logic
- `webui/static/style.css`: frontend layout and visual design
- `webui/static/i18n/*.json`: UI translations
- `tests/*.py`: unit tests

The cyanrip source tree under `cyanrip-src/` is local reference material and is intentionally ignored by Git. The WebUI should interact with cyanrip through CLI arguments and process output only.

## Transport

HTTP remains necessary for:

- Initial HTML document
- Static JS/CSS/icon assets
- Locale JSON files
- Cover image previews
- First settings/capability request

Normal JSON actions use WebSocket RPC after startup:

- `/api/probe`
- `/api/fs/directories`
- `/api/fs/files`
- `/api/drives`
- `/api/drives/offset`
- `/api/session/reset`
- `/api/preview`
- `/api/scan`
- `/api/start`
- `/api/stop`
- `/api/eject`
- `/api/status`
- `/api/logs`
- `/api/cover/upload`
- `/api/cover/session`

HTTP fallback for these JSON actions is disabled by default and can be enabled with `--enable-http-fallback`.

## AppImage

Build:

```bash
./scripts/build_appimage.sh
```

Expected output:

```text
dist/cyanrip-webui-v0.1-alpha-x86_64.AppImage
```

Packaging notes:

- `bin/cyanrip` must exist and be executable before building.
- The build copies `bin/cyanrip` into `AppDir/usr/bin/cyanrip`.
- AppImage runtime exposes the bundled binary through `CYANRIP_WEBUI_BUNDLED_CYANRIP`.
- Frontend storage must not persist `/tmp/.mount.../usr/bin/cyanrip`; it stores `./bin/cyanrip` as the portable marker and resolves it to the bundled binary at runtime.
- Runtime output defaults to `output` next to the AppImage.
- License notices are copied into `usr/share/licenses/cyanrip-webui`.
- The build intentionally collects only the PySide6 modules used by the launcher (`QtCore`, `QtGui`, `QtWidgets`, `QtSvg`). Avoid `--collect-all PySide6`; it pulls unused QML, WebEngine, SQL, Designer, and platform plugins and creates noisy missing-library warnings.
- PyInstaller is run with `LC_ALL=C.UTF-8 LANG=C.UTF-8` so localized `ldconfig` output does not produce parser warnings while Qt still sees a UTF-8 locale.
- AppStream metadata is copied from `packaging/cyanrip-webui.appdata.xml` with the reverse-DNS component ID `io.github.silverlps.cyanrip-webui`. Current appimagetool builds may still print an optional metadata warning because they look for `cyanrip-webui.appdata.xml` based on the desktop filename, while appstreamcli warns if that filename does not match the reverse-DNS component ID. This is harmless for AppImage execution.
- PyInstaller may warn about Qt's optional `libqtiff.so` imageformat plugin if `libtiff.so.5` is not available on the build host. The build removes that unused TIFF plugin before packaging. The application does not load TIFF images; tray and desktop icons use SVG, and cover handling is browser/server-side.
- appimagetool may download the type-2 runtime if it is not cached locally. That is expected and not an application issue.

## Tests

```bash
python3 -m unittest discover -s tests
```

Optional syntax check:

```bash
python3 -m compileall app.py launcher.py webui tests
```

## Release Checklist

- Run the unit tests.
- Run a source-tree smoke test.
- Build the AppImage.
- Start the AppImage on a KDE/X11 desktop and verify tray menu, browser access, scan, and quit.
- Verify the bundled cyanrip binary is used by default.
- Verify the output directory is created next to the AppImage.
- Verify the AppImage contains license files for cyanrip-webui, dependencies, and cyanrip.
- Run a Git history secret scan before publishing.
