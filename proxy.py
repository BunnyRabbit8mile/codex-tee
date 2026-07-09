"""Pure stdlib proxy: Codex -> trace -> Codex++ -> DeepSeek."""
import http.server, json, os, socket, threading, time, urllib.request, urllib.error

LISTEN = ("127.0.0.1", 5000)
TARGET = "http://127.0.0.1:57321"
LS_KEY = os.environ.get("LANGSMITH_API_KEY") 
LS_PROJECT = os.environ.get("LANGSMITH_PROJECT", "codex-cache-analysis")

ls = None
if LS_KEY:
    from langsmith import Client
    ls = Client(api_key=LS_KEY)
    print(f"[proxy] LangSmith: {LS_PROJECT}")

turn = [0]

def do_trace(req_body: bytes, resp_body: bytes, lat_ms: float):
    try:
        rj = json.loads(resp_body)
    except Exception:
        return
    usage = rj.get("usage", {}) or {}
    details = usage.get("prompt_tokens_details", {}) or {}
    pt = usage.get("prompt_tokens", 0)
    ct = usage.get("completion_tokens", 0)
    hit = usage.get("prompt_cache_hit_tokens", 0)
    miss = usage.get("prompt_cache_miss_tokens", 0)
    cached = details.get("cached_tokens", 0)
    total = hit + miss
    rate = round(hit / total * 100, 1) if total else (round(cached / pt * 100, 1) if cached and pt else 0)

    turn[0] += 1
    t = turn[0]
    model = "?"
    try:
        model = json.loads(req_body).get("model", "?")
    except Exception:
        pass

    print(f"[turn {t:03d}] model={model} | prompt={pt} hit={hit} miss={miss} ({rate}%) | completion={ct} | {lat_ms:.0f}ms")

    if ls:
        try:
            ls.create_run(
                name=f"turn_{t:03d}", run_type="llm",
                inputs={"messages": (json.loads(req_body) or {}).get("messages", [])},
                outputs={"choices": rj.get("choices")},
                project_name=LS_PROJECT,
                extra={"metadata": {"turn": t, "model": model, "latency_ms": round(lat_ms),
                        "prompt_tokens": pt, "completion_tokens": ct, "cached_tokens": cached,
                        "cache_hit_tokens": hit, "cache_miss_tokens": miss, "cache_hit_rate_pct": rate}})
        except Exception:
            pass


class Proxy(http.server.BaseHTTPRequestHandler):

    def do_GET(self):
        if self.path == "/_health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "target": TARGET}).encode())
            return
        self._forward("GET")

    def do_POST(self):
        self._forward("POST")

    def do_OPTIONS(self):
        self._forward("OPTIONS")

    def _forward(self, method):
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len) if content_len else b""
        url = TARGET + self.path
        t0 = time.time()

        req = urllib.request.Request(url, data=body, method=method)
        skip = {"host", "content-length", "content-type"}
        for k, v in self.headers.items():
            if k.lower() not in skip:
                req.add_header(k, v)
        if body:
            req.add_header("Content-Type", self.headers.get("Content-Type", "application/json"))
            req.add_header("Content-Length", str(len(body)))

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                lat = (time.time() - t0) * 1000
                resp_body = resp.read()
                self.send_response(resp.status)
                for k, v in resp.getheaders():
                    if k.lower() not in ("transfer-encoding",):
                        self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp_body)
                if "/chat/completions" in self.path:
                    threading.Thread(target=do_trace, args=(body, resp_body, lat), daemon=True).start()
        except urllib.error.HTTPError as e:
            lat = (time.time() - t0) * 1000
            resp_body = e.read()
            self.send_response(e.code)
            for k, v in e.headers.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(resp_body)
        except Exception as e:
            lat = (time.time() - t0) * 1000
            err = json.dumps({"error": str(e)}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(err)

    def log_message(self, fmt, *args):
        pass  # suppress default logging

if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(LISTEN, Proxy)
    print(f"[proxy] Target: {TARGET}  |  http://{LISTEN[0]}:{LISTEN[1]}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()

