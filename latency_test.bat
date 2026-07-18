@echo off
set KEY=sk-1bc4f55884dd40b0b6ce28726723b0ef

echo === DIRECT flash (--ssl-no-revoke) ===
curl.exe --ssl-no-revoke -w "\nDIRECT: %%{time_total}s %%{http_code}" -X POST https://api.deepseek.com/v1/chat/completions -H "Authorization: Bearer %KEY%" -H "Content-Type: application/json" -d "{\"model\":\"deepseek-v4-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":5}" --noproxy "*" -m 15 -o NUL
echo.

echo === PROXY 57321 flash ===
curl.exe -w "\nPROXY: %%{time_total}s %%{http_code}" -X POST http://127.0.0.1:57321/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"deepseek-v4-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":5}" --noproxy "*" -m 15 -o NUL
echo.

echo === PROXY 57322 flash (codex-tee only) ===
curl.exe -w "\nPROXY_57322: %%{time_total}s %%{http_code}" -X POST http://127.0.0.1:57322/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"deepseek-v4-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":5}" --noproxy "*" -m 15 -o NUL
echo.
