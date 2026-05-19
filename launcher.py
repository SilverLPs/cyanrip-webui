from __future__ import annotations

import argparse
import logging
import os
import signal
import shutil
import subprocess
import sys
from pathlib import Path
import threading
import time
import webbrowser
from urllib.error import URLError
from urllib.request import Request, urlopen


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Start cyanrip-webui with optional tray integration.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", default=8080, type=int, help="Bind port (default: 8080)")
    parser.add_argument("--debug", action="store_true", help="Enable Flask debug mode")
    parser.add_argument("--headless", action="store_true", help="Force headless mode even on desktop systems")
    parser.add_argument("--no-tray", action="store_true", help="Disable tray integration")
    parser.add_argument("--open-browser", action="store_true", help="Open browser automatically on startup")
    parser.add_argument(
        "--enable-http-fallback",
        action="store_true",
        help="Allow frontend HTTP fallback when WebSocket is unavailable.",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Deprecated alias. Browser auto-open is disabled by default.",
    )
    return parser.parse_args()


def run_backend(host: str, port: int, debug: bool) -> None:
    from webui import create_app

    app = create_app()
    if not debug:
        logging.getLogger("werkzeug").setLevel(logging.ERROR)
        app.logger.setLevel(logging.ERROR)
    app.run(
        host=host,
        port=port,
        debug=debug,
        threaded=True,
        use_reloader=False,
    )


def wait_until_ready(url: str, timeout_seconds: float = 20.0, alive_check: object | None = None) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if callable(alive_check) and not alive_check():
            return False
        try:
            request = Request(url, headers={"Accept": "text/html"}, method="GET")
            with urlopen(request, timeout=1.6):  # nosec: B310 - local service probe
                return True
        except URLError:
            time.sleep(0.2)
        except OSError:
            time.sleep(0.2)
    return False


def notify_desktop(base_url: str) -> None:
    tool = shutil.which("notify-send")
    if not tool:
        return
    icon = tray_icon_path()
    command = [
        tool,
        "--app-name=cyanrip-webui",
        "--icon",
        str(icon),
        "Application is now running in the background",
        f"Open {base_url} in your browser. Use the system tray icon to open or quit cyanrip-webui.",
    ]
    try:
        subprocess.run(command, check=False, timeout=4)
    except OSError:
        pass


def has_gui_session() -> bool:
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        return True
    session_type = str(os.environ.get("XDG_SESSION_TYPE") or "").strip().lower()
    return session_type in {"wayland", "x11"}


def resource_path(*parts: str) -> Path:
    for root in (
        os.environ.get("CYANRIP_WEBUI_APPDIR"),
        os.environ.get("APPDIR"),
        getattr(sys, "_MEIPASS", None),
        Path(__file__).resolve().parent,
    ):
        if not root:
            continue
        candidate = Path(root).joinpath(*parts)
        if candidate.exists():
            return candidate
    return Path(__file__).resolve().parent.joinpath(*parts)


def tray_icon_path() -> Path:
    explicit = str(os.environ.get("CYANRIP_WEBUI_ICON") or "").strip()
    if explicit:
        candidate = Path(explicit)
        if candidate.exists():
            return candidate
    return resource_path("packaging", "cyanrip-webui.svg")


def run_with_qt_tray(base_url: str, stop_event: threading.Event) -> bool:
    try:
        from PySide6.QtCore import QTimer
        from PySide6.QtGui import QAction, QIcon
        from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon
    except Exception as exc:
        print(f"Qt tray integration unavailable: {exc}")
        return False

    app = QApplication.instance() or QApplication(["cyanrip-webui"])
    app.setQuitOnLastWindowClosed(False)

    if not QSystemTrayIcon.isSystemTrayAvailable():
        print("Qt system tray is not available in this desktop session.")
        return False

    icon = QIcon(str(tray_icon_path()))
    if icon.isNull():
        print("Qt tray icon could not be loaded.")
        return False

    tray = QSystemTrayIcon(icon)
    tray.setToolTip("cyanrip-webui")

    menu = QMenu()
    open_action = QAction("Open Web UI", menu)
    quit_action = QAction("Quit", menu)
    menu.addAction(open_action)
    menu.addSeparator()
    menu.addAction(quit_action)
    tray.setContextMenu(menu)

    open_action.triggered.connect(lambda: webbrowser.open(base_url, new=2))
    quit_action.triggered.connect(lambda: (stop_event.set(), tray.hide(), app.quit()))

    def on_activated(reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason in {QSystemTrayIcon.ActivationReason.Trigger, QSystemTrayIcon.ActivationReason.DoubleClick}:
            webbrowser.open(base_url, new=2)

    tray.activated.connect(on_activated)

    timer = QTimer()
    timer.setInterval(300)
    timer.timeout.connect(lambda: (tray.hide(), app.quit()) if stop_event.is_set() else None)
    timer.start()

    previous_sigint = signal.getsignal(signal.SIGINT)

    def handle_sigint(_signum: int, _frame: object) -> None:
        stop_event.set()
        tray.hide()
        app.quit()

    signal.signal(signal.SIGINT, handle_sigint)
    try:
        tray.show()
        app.exec()
    finally:
        signal.signal(signal.SIGINT, previous_sigint)
        tray.hide()
    return True


def run_with_tray_fallbacks(base_url: str, stop_event: threading.Event) -> bool:
    return run_with_qt_tray(base_url, stop_event)


def main() -> int:
    args = parse_args()
    if args.enable_http_fallback:
        os.environ["CYANRIP_WEBUI_HTTP_FALLBACK"] = "1"
    stop_event = threading.Event()

    backend_thread = threading.Thread(
        target=run_backend,
        args=(args.host, args.port, args.debug),
        daemon=True,
    )
    backend_thread.start()

    base_url = f"http://{args.host}:{args.port}"
    ready = wait_until_ready(base_url, alive_check=backend_thread.is_alive)
    if not ready and not backend_thread.is_alive():
        print("cyanrip-webui backend failed to start.")
        return 1

    should_open_browser = bool(args.open_browser and not args.no_browser)
    if ready and should_open_browser:
        try:
            webbrowser.open(base_url, new=2)
        except Exception:
            pass

    forced_headless = args.headless or not has_gui_session()
    if forced_headless:
        print(f"cyanrip-webui running at {base_url} (headless mode)")
    else:
        notify_desktop(base_url)

    if forced_headless or args.no_tray:
        try:
            while backend_thread.is_alive() and not stop_event.is_set():
                time.sleep(0.5)
        except KeyboardInterrupt:
            stop_event.set()
        return 0

    tray_started = run_with_tray_fallbacks(base_url, stop_event)
    if not tray_started:
        try:
            while backend_thread.is_alive() and not stop_event.is_set():
                time.sleep(0.5)
        except KeyboardInterrupt:
            stop_event.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
