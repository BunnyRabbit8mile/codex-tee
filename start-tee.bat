@echo off
REM codex-tee auto-start
REM set LANGSMITH_API_KEY=your_key_here
set LANGSMITH_PROJECT=codex-tee
timeout /t 2 /nobreak >nul
echo [codex-tee] Starting tee proxy on 127.0.0.1:57322...
node --use-system-ca "%~dp0server.js"
