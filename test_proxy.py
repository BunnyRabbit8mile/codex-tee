import urllib.request, json
body = json.dumps({"model":"deepseek-chat","messages":[{"role":"user","content":"say working"}],"max_tokens":5}).encode()
req = urllib.request.Request("http://127.0.0.1:5000/v1/chat/completions", data=body, headers={"Content-Type":"application/json"})
with urllib.request.urlopen(req, timeout=15) as r:
    data = json.loads(r.read())
    print("OK:", data["choices"][0]["message"]["content"])
    u = data.get("usage", {})
    print("prompt:", u.get("prompt_tokens"))
    print("hit:", u.get("prompt_cache_hit_tokens"))
    print("miss:", u.get("prompt_cache_miss_tokens"))
