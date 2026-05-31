# Third-Party Licenses

This project bundles or depends on the following components for source-tree runs and AppImage builds.

## Bundled Runtime Component

- cyanrip: LGPL-2.1-or-later, based on the license file shipped with the local cyanrip source archive used for packaging. The AppImage build script copies that license into the AppImage when `cyanrip-src/cyanrip-src-v0.9.3.1/LICENSE.md` is available.

## Python Dependencies

- Python runtime: Python Software Foundation License Version 2 (PSF-2.0)
- Flask: BSD-3-Clause
- flask-sock: MIT
- simple-websocket: MIT
- wsproto: MIT
- PySide6 / Qt for Python: LGPL-3.0-only or GPL-2.0-only/GPL-3.0-only/commercial terms depending on the Qt components used
- Werkzeug: BSD-3-Clause
- Jinja2: BSD-3-Clause
- MarkupSafe: BSD-3-Clause
- itsdangerous: BSD-3-Clause
- click: BSD-3-Clause
- blinker: MIT

The AppImage build also contains Python and transitive runtime files collected by PyInstaller. Before publishing a binary release, verify the final AppImage contents and dependency versions against this notice.
