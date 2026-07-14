@echo off
REM codex-tee auto-start
set LANGFUSE_PUBLIC_KEY=pk-lf-2519cd87-652e-4d00-bd81-6c9b0cfb698b
set LANGFUSE_SECRET_KEY=sk-lf-2c3de659-a9b8-49a6-b94b-37b4452a187a
set LANGFUSE_HOST=https://cloud.langfuse.com
set LANGFUSE_PROJECT=codex-tee
set HTTPS_PROXY=http://127.0.0.1:7897
timeout /t 2 /nobreak >nul
node --use-system-ca "%~dp0server.js"
