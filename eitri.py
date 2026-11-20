#!/usr/bin/env python3
"""Eitri: a self-hosted save library and editor for single-player games.

    python3 eitri.py [--saves-dir DIR] [--host 127.0.0.1] [--port 8640] [--offline]

Standard library only. The page and its plugins are static files; this server stores save files and metadata
(saves.py, API in API.md) and serves the page with its initial data inlined. There is no login: it listens on
127.0.0.1 by default. Only bind it to other addresses on a network you trust.
"""
import argparse
import json
import os
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
}
# The page loads only its own files. Images: covers via the API, Steam search thumbnails from Steam's CDN.
CSP = ("default-src 'self'; img-src 'self' data: https://*.steamstatic.com; style-src 'self' 'unsafe-inline'; script-src 'self'; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")

saves = None  # imported in main() after the environment is set


class Handler(BaseHTTPRequestHandler):
    server_version = "Eitri"
    sys_version = ""

    def log_message(self, fmt, *args):
        if os.environ.get("EITRI_QUIET") != "1":
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def _plain(self, status, text):
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _page(self):
        data = json.dumps(saves.state()).replace("</", "<\\/")
        body = (STATIC / "index.html").read_text(encoding="utf-8").replace("__INITIAL_DATA__", data).encode()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", CONTENT_TYPES[".html"])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        self.wfile.write(body)

    def _static(self, rel):
        path = (STATIC / rel).resolve()
        if STATIC not in path.parents or not path.is_file() or path.name == "index.html":
            return self._plain(HTTPStatus.NOT_FOUND, "not found")
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", CONTENT_TYPES.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _api(self, method):
        if self.path.startswith(saves.API_PREFIX):
            return saves.dispatch(self, method)
        return self._plain(HTTPStatus.NOT_FOUND, "not found")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            return self._page()
        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])
        return self._api("GET")

    def do_POST(self):
        return self._api("POST")

    def do_PUT(self):
        return self._api("PUT")

    def do_DELETE(self):
        return self._api("DELETE")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Eitri save library and editor")
    ap.add_argument("--saves-dir", default=os.environ.get("EITRI_SAVES_DIR", "saves"),
                    help="where games and versions are stored (default ./saves, env EITRI_SAVES_DIR)")
    ap.add_argument("--host", default=os.environ.get("EITRI_HOST", "127.0.0.1"),
                    help="address to listen on (default 127.0.0.1; there is no login)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("EITRI_PORT", "8640")))
    ap.add_argument("--offline", action="store_true", default=os.environ.get("EITRI_OFFLINE") == "1",
                    help="never contact Steam or PCGamingWiki (env EITRI_OFFLINE=1)")
    args = ap.parse_args(argv)

    root = Path(args.saves_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    os.environ["EITRI_SAVES_DIR"] = str(root)
    if args.offline:
        os.environ["EITRI_OFFLINE"] = "1"
    global saves
    sys.path.insert(0, str(HERE))
    import saves as _saves
    saves = _saves

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Eitri on http://{args.host}:{args.port}/  saves: {root}" + ("  (offline)" if args.offline else ""), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
