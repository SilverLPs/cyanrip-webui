from __future__ import annotations

import argparse
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from urllib.error import URLError
from urllib.request import Request, urlopen

from webui import create_app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Start cyanrip-webui with optional tray integration.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", default=8080, type=int, help="Bind port (default: 8080)")
    parser.add_argument("--debug", action="store_true", help="Enable Flask debug mode")
    parser.add_argument("--headless", action="store_true", help="Force headless mode even on desktop systems")
    parser.add_argument("--no-tray", action="store_true", help="Disable tray integration")
    parser.add_argument("--open-browser", action="store_true", help="Open browser automatically on startup")
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Deprecated alias. Browser auto-open is disabled by default.",
    )
    return parser.parse_args()


def run_backend(host: str, port: int, debug: bool) -> None:
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


def notify_desktop(title: str, message: str) -> None:
    tool = shutil.which("notify-send")
    if not tool:
        return
    try:
        subprocess.run([tool, title, message], check=False, timeout=4)
    except OSError:
        pass


def has_gui_session() -> bool:
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        return True
    session_type = str(os.environ.get("XDG_SESSION_TYPE") or "").strip().lower()
    return session_type in {"wayland", "x11"}


def tray_backend_candidates() -> list[str | None]:
    preferred = os.environ.get("PYSTRAY_BACKEND")
    if preferred:
        return [preferred]

    if not has_gui_session():
        return [None]

    candidates: list[str | None] = ["appindicator", "gtk"]
    session_type = str(os.environ.get("XDG_SESSION_TYPE") or "").strip().lower()
    # XEmbed is a legacy fallback. On Wayland sessions it can create a broken
    # XWayland icon without a working menu, so only try it for real X11.
    if session_type == "x11" or (os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY")):
        candidates.append("xorg")
    candidates.append(None)
    return candidates


def create_tray_image() -> object:
    from PIL import Image, ImageDraw

    size = 128
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle((10, 10, 118, 118), radius=18, fill=(10, 42, 55, 255))
    draw.rounded_rectangle((18, 18, 110, 110), radius=14, outline=(47, 212, 197, 255), width=6)
    draw.ellipse((39, 39, 89, 89), outline=(245, 178, 92, 255), width=8)
    draw.ellipse((56, 56, 72, 72), fill=(47, 212, 197, 255))
    return image


def create_tray_icon(menu: object) -> object:
    import pystray

    return pystray.Icon("cyanrip-webui", create_tray_image(), "cyanrip-webui", menu=menu)


def run_with_tray(base_url: str, stop_event: threading.Event) -> None:
    import pystray

    def open_ui(_icon: object, _item: object) -> None:
        webbrowser.open(base_url, new=2)

    def quit_ui(icon_obj: object, _item: object) -> None:
        stop_event.set()
        icon_obj.stop()

    menu = pystray.Menu(
        pystray.MenuItem("Open Web UI", open_ui, default=True),
        pystray.MenuItem("Quit", quit_ui),
    )
    icon = create_tray_icon(menu)
    icon.run()


def run_with_tray_fallbacks(base_url: str, stop_event: threading.Event) -> bool:
    last_error: Exception | None = None
    for candidate in tray_backend_candidates():
        try:
            if candidate:
                os.environ["PYSTRAY_BACKEND"] = candidate
            elif "PYSTRAY_BACKEND" in os.environ:
                del os.environ["PYSTRAY_BACKEND"]
            for module_name in list(sys.modules.keys()):
                if module_name == "pystray" or module_name.startswith("pystray."):
                    sys.modules.pop(module_name, None)
            run_with_tray(base_url, stop_event)
            return True
        except KeyboardInterrupt:
            stop_event.set()
            return True
        except Exception as exc:
            last_error = exc
            continue

    if last_error is not None:
        print(f"Tray integration unavailable: {last_error}")
    return False


def main() -> int:
    args = parse_args()
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
        notify_desktop(
            "cyanrip-webui",
            "The backend is running in the background. Use the tray icon to open or quit.",
        )

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
