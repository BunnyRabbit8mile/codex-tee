@echo off
REM codex-tee auto-start
timeout /t 2 /nobreak >nul
node --use-system-ca "%~dp0server.js"
