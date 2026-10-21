"""Start the Mini App.

    python run.py                # server + temporary HTTPS tunnel (cloudflared if bin/ has it, else localhost.run)
    python run.py --ssh          # force the localhost.run tunnel over ssh
    python run.py --local        # server only, open http://localhost:8080 in a browser (test user)

The tunnel's public address is written to data/webapp_url.txt; the bot picks it up
and re-points its menu button whenever the address changes.
"""
import argparse
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import uvicorn
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
URL_FILE = ROOT / "data" / "webapp_url.txt"
load_dotenv(ROOT / ".env")


def publish(url: str):
    URL_FILE.parent.mkdir(exist_ok=True)
    if not URL_FILE.exists() or URL_FILE.read_text().strip() != url:
        URL_FILE.write_text(url)
        print(f"\n  Mini App URL: {url}\n  Open the bot in Telegram and press «Расписание».\n", flush=True)


def tunnel_command(kind: str, port: int):
    if kind == "cloudflared":
        exe = ROOT / "bin" / ("cloudflared.exe" if os.name == "nt" else "cloudflared")
        return [str(exe), "tunnel", "--no-autoupdate", "--url", f"http://localhost:{port}"], \
            r"https://[a-z0-9-]+\.trycloudflare\.com"
    return ["ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30",
            "-o", "ExitOnForwardFailure=yes", "-R", f"80:localhost:{port}", "nokey@localhost.run",
            "--", "--output", "json"], r"https://[a-z0-9]+\.lhr\.life"


def reachable(url: str) -> bool:
    try:
        return httpx.get(url, timeout=15, follow_redirects=True).status_code < 500
    except httpx.HTTPError:
        return False


def watch_tunnel(proc, current_url, every=60, strikes=3):
    """A quick tunnel that lost its connection (the computer slept, Wi-Fi dropped) can come back
    without its address. When the public address stops answering while the internet works, restart it."""
    misses = 0
    while proc.poll() is None:
        time.sleep(every)
        url = current_url()
        if not url:
            continue
        if reachable(url):
            misses = 0
        elif reachable("https://api.telegram.org"):
            misses += 1
            if misses >= strikes:
                print("  tunnel address is gone, restarting the tunnel…", flush=True)
                proc.kill()
                return


def keep_tunnel(kind: str, port: int):
    """Run the tunnel forever, restarting it when it drops or loses its address."""
    cmd, pattern = tunnel_command(kind, port)
    while True:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace")
        found = {"url": None}
        threading.Thread(target=watch_tunnel, args=(proc, lambda: found["url"]), daemon=True).start()
        for line in proc.stdout:
            m = re.search(pattern, line)
            if m:
                found["url"] = m.group(0)
                publish(found["url"])
        proc.wait()
        print("  tunnel dropped, reconnecting…", flush=True)
        time.sleep(3)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", action="store_true", help="no tunnel, browser-only test mode")
    parser.add_argument("--ssh", action="store_true", help="use localhost.run over ssh even if cloudflared is present")
    args = parser.parse_args()
    port = int(os.getenv("PORT", "8080"))
    URL_FILE.unlink(missing_ok=True)  # an old tunnel address is dead by now
    if not args.local:
        has_cloudflared = (ROOT / "bin" / ("cloudflared.exe" if os.name == "nt" else "cloudflared")).exists()
        kind = "ssh" if args.ssh or not has_cloudflared else "cloudflared"
        threading.Thread(target=keep_tunnel, args=(kind, port), daemon=True).start()
    print(f"  Local test:   http://localhost:{port}\n", flush=True)
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
