#!/usr/bin/env python3
"""Loopback-only Xiaomi account QR login for the standalone camera relay."""

import argparse
import json
import os
import re
import stat
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def read(url, host, limit, timeout=8):
    address = urllib.parse.urlsplit(url)
    if address.scheme != "https" or address.netloc != host:
        raise ValueError("Unrecognized Xiaomi endpoint")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with client.open(request, timeout=timeout) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Xiaomi response too large")
        return response.headers.get_content_type(), data


def json_payload(data):
    return json.loads(data.decode().removeprefix("&&&START&&&"))


def poll_host(url):
    address = urllib.parse.urlsplit(url)
    if address.scheme != "https" or not re.fullmatch(r"(?:[a-z0-9-]{1,63}\.)?lp\.account\.xiaomi\.com", address.netloc):
        raise ValueError("Unrecognized Xiaomi polling endpoint")
    return address.netloc


def new_challenge():
    query = urllib.parse.urlencode({
        "_qrsize": "300", "qs": "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
        "callback": "https://sts.api.io.mi.com/sts", "_hasLogo": "false",
        "sid": "xiaomiio", "serviceParam": "", "_locale": "zh_CN",
        "_dc": str(int(time.time() * 1000)),
    })
    url = "https://account.xiaomi.com/longPolling/loginUrl?" + query
    challenge = json_payload(read(url, "account.xiaomi.com", 32768)[1])
    host = poll_host(challenge["lp"])
    ttl = min(int(challenge.get("timeout", 300)), 300)
    if ttl <= 0:
        raise ValueError("Invalid Xiaomi QR lifetime")
    deadline = time.monotonic() + ttl
    image_type, image = read(challenge["qr"], "account.xiaomi.com", 262144)
    if image_type not in {"image/png", "image/jpeg"}:
        raise ValueError("Invalid Xiaomi QR image")
    return challenge["lp"], host, deadline, image_type, image


def save_account(target, receipt):
    account = str(receipt["userId"])
    token = receipt["passToken"]
    if not re.fullmatch(r"[0-9]{1,24}", account) or not isinstance(token, str) or not re.fullmatch(
        r"[A-Za-z0-9_:/+.=-]{16,4096}", token
    ):
        raise ValueError("Invalid Xiaomi login receipt")
    fd, temporary = tempfile.mkstemp(dir=target.parent)
    try:
        with os.fdopen(fd, "w") as file:
            json.dump({"xiaomi": {account: token}}, file)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        # A fresh login must not overwrite an enrollment already on disk.
        os.link(temporary, target)
    finally:
        os.unlink(temporary)


PAGE = """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>小米摄像头授权</title>
<style>
body{margin:0;padding:40px 20px;background:#101420;color:#f6f6fb;font:16px system-ui}
main{max-width:490px;margin:auto}h1{font-size:24px}p{line-height:1.6}
button{border:0;border-radius:20px;background:#ffc78a;color:#301b00;padding:10px 18px;font:inherit}
img{display:block;margin:16px 0;max-width:100%;border-radius:12px}img[hidden]{display:none}
</style>
<main><h1>小米摄像头授权</h1><p>生成小米登录二维码，用已登录的小米手机扫码并在手机上确认。</p>
<button id="start">生成登录二维码</button><img id="qr" width="300" height="300" alt="小米账号登录二维码" hidden>
<p id="status" role="status"></p></main>
<script>
const button = document.querySelector('#start'), qr = document.querySelector('#qr');
const status = document.querySelector('#status');
const messages = {
 saved:'扫码确认成功，授权已在本机保存。可以关闭页面。',
 expired:'二维码已到期，请重新生成。',
 failed:'本次授权未完成，可以重新生成二维码。',
};
async function check() {
 const response = await fetch('/status'); const {phase, remaining} = await response.json();
 status.textContent = messages[phase] || '';
 if (phase === 'pending') {
  status.textContent = '等待手机确认，约剩 ' + remaining + ' 秒。';
  if (qr.hidden) {qr.src = '/qr?' + Date.now(); qr.hidden = false;}
  button.disabled = true;
  setTimeout(refreshStatus, 1000);
  return;
 }
 qr.hidden = true;
 button.disabled = phase === 'saved';
}
function retry() {qr.hidden=true; status.textContent=messages.failed; button.disabled=false;}
function refreshStatus() {check().catch(() => setTimeout(refreshStatus, 1000));}
button.onclick = async () => {
 button.disabled = true; qr.hidden = true; status.textContent = '正在向小米请求二维码…';
 try {
  const response = await fetch('/start', {method:'POST'});
  if (!response.ok) throw new Error();
  await check();
 } catch (_) {retry();}
};
check().catch(retry);
</script></html>"""


def serve(port, target):
    authority = f"127.0.0.1:{port}"
    origin = f"http://{authority}"
    lock = threading.Lock()
    state = {"phase": "saved" if target.exists() else "idle", "image": None}

    def poll(url, host, deadline):
        phase = "expired"
        try:
            while time.monotonic() < deadline:
                try:
                    timeout = min(60, max(0.1, deadline - time.monotonic()))
                    _, data = read(url, host, 32768, timeout=timeout)
                except urllib.error.HTTPError as error:
                    status = error.code
                    error.close()
                    print(f"Xiaomi QR polling HTTP {status}", flush=True)
                except OSError as error:
                    if not isinstance(error, TimeoutError):
                        print(f"Xiaomi QR polling interrupted: {type(error).__name__}", flush=True)
                else:
                    try:
                        receipt = json_payload(data) if data else None
                    except ValueError:
                        receipt = None
                    if isinstance(receipt, dict) and "userId" in receipt and "passToken" in receipt:
                        save_account(target, receipt)
                        phase = "saved"
                        break
                time.sleep(min(2, max(0, deadline - time.monotonic())))
        except (ValueError, OSError, KeyError, TypeError):
            phase = "failed"
        finally:
            with lock:
                state.update(phase=phase, image=None)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, kind="text/plain", body=b""):
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def local(self):
            return self.headers.get("Host") == authority and not any(
                header in self.headers for header in ("Forwarded", "X-Forwarded-Host", "X-Forwarded-For")
            )

        def do_GET(self):
            if not self.local() or self.headers.get("Sec-Fetch-Site") not in {None, "none", "same-origin"}:
                return self.reply(403)
            if self.path == "/":
                return self.reply(200, "text/html; charset=utf-8", PAGE.encode())
            with lock:
                if self.path == "/status":
                    data = {"phase": state["phase"]}
                    if state["phase"] == "pending":
                        data["remaining"] = max(0, round(state["deadline"] - time.monotonic()))
                    body = json.dumps(data).encode()
                    return self.reply(200, "application/json", body)
                if urllib.parse.urlsplit(self.path).path == "/qr" and state["image"]:
                    return self.reply(200, *state["image"])
            return self.reply(404)

        def do_POST(self):
            if not self.local() or self.headers.get("Origin") != origin or self.path != "/start":
                return self.reply(403)
            with lock:
                if state["phase"] in {"pending", "starting", "saved"}:
                    return self.reply(409)
                state["phase"] = "starting"
            try:
                url, host, deadline, kind, image = new_challenge()
            except (ValueError, OSError, KeyError, TypeError):
                with lock:
                    state.update(phase="failed", image=None)
                return self.reply(502)
            with lock:
                state.update(phase="pending", deadline=deadline, image=(kind, image))
            threading.Thread(target=poll, args=(url, host, deadline), daemon=True).start()
            return self.reply(204)

    with ThreadingHTTPServer(("127.0.0.1", port), Handler) as server:
        print(f"Xiaomi camera login listening at {origin}/", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=19842)
    parser.add_argument("output", type=Path, help="new private go2rtc JSON overlay")
    options = parser.parse_args()
    target = options.output.resolve()
    parent = target.parent.stat()
    if ".local" not in target.parts or parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) & 0o077:
        parser.error("output requires a private .local directory")
    serve(options.port, target)
