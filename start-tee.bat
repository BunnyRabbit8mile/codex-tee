@echo off
REM codex-tee auto-start
REM set LANGSMITH_API_KEY=your_key_here
set LANGSMITH_PROJECT=codex-tee
timeout /t 2 /nobreak >nul
echo [codex-tee] Starting tee proxy on 127.0.0.1:57322...
node --use-system-ca "C:\Users\hotsa\Documents\Codex\2026-06-29\fake-it-until-make-it-2\work\codex-tee\server.js"
