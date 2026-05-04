from __future__ import annotations

import argparse
import logging
import os
import shutil
import subprocess
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
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open browser on startup")
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


def wait_until_ready(url: str, timeout_seconds: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
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
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def create_tray_icon() -> object:
    import pystray
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (64, 64), (14, 40, 52, 255))
    draw = ImageDraw.Draw(image)
    draw.rectangle((6, 6, 58, 58), outline=(55, 207, 194, 255), width=4)
    draw.ellipse((18, 18, 46, 46), outline=(255, 191, 93, 255), width=4)
    draw.ellipse((28, 28, 36, 36), fill=(55, 207, 194, 255))
    return pystray.Icon("cyanrip-webui", image, "cyanrip-webui")


def run_with_tray(base_url: str, stop_event: threading.Event) -> None:
    import pystray

    icon = create_tray_icon()

    def open_ui(_icon: object, _item: object) -> None:
        webbrowser.open(base_url, new=2)

    def quit_ui(icon_obj: object, _item: object) -> None:
        stop_event.set()
        icon_obj.stop()

    icon.menu = pystray.Menu(
        pystray.MenuItem("Open Web UI", open_ui, default=True),
        pystray.MenuItem("Quit", quit_ui),
    )
    icon.run()


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
    ready = wait_until_ready(base_url)
    if ready and not args.no_browser:
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

    try:
        run_with_tray(base_url, stop_event)
    except Exception:
        print("Tray integration unavailable; continuing without tray.")
        try:
            while backend_thread.is_alive() and not stop_event.is_set():
                time.sleep(0.5)
        except KeyboardInterrupt:
            stop_event.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
