import subprocess, sys, os
# Set LANGSMITH_API_KEY env var before running
os.environ["LANGSMITH_PROJECT"] = "codex-cache-analysis"

base = os.path.dirname(os.path.abspath(__file__))
DETACHED = 0x00000008
p = subprocess.Popen(
    [sys.executable, "-u", os.path.join(base, "proxy.py")],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    creationflags=DETACHED,
    close_fds=True,
)
print(f"PROXY_PID={p.pid}")




