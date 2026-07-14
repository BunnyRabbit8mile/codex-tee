@echo off
REM codex-tee auto-start
set LANGFUSE_PUBLIC_KEY=REDACTED
set LANGFUSE_SECRET_KEY=REDACTED
set LANGFUSE_HOST=https://cloud.langfuse.com
set LANGFUSE_PROJECT=codex-tee
timeout /t 2 /nobreak >nul
node --use-system-ca "%~dp0server.js"
