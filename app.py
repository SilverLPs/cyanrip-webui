from __future__ import annotations

import argparse
import logging
import os

app = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="cyanrip-webui")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", default=8080, type=int, help="Bind port (default: 8080)")
    parser.add_argument("--debug", action="store_true", help="Enable Flask debug mode")
    parser.add_argument(
        "--enable-http-fallback",
        action="store_true",
        help="Allow the frontend to fall back to HTTP polling/API calls if WebSocket is unavailable.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if args.enable_http_fallback:
        os.environ["CYANRIP_WEBUI_HTTP_FALLBACK"] = "1"
    from webui import create_app

    app = create_app()
    if not args.debug:
        logging.getLogger("werkzeug").setLevel(logging.ERROR)
        app.logger.setLevel(logging.ERROR)
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)
else:
    from webui import create_app

    app = create_app()
