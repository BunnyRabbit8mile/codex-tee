@echo off
if "%QIANFAN_KEY%"=="" (
    echo Error: QIANFAN_KEY environment variable not set
    exit /b 1
)

echo === DIRECT qianfan-code-latest ===
curl.exe --ssl-no-revoke -w "\nDIRECT: %%{time_total}s %%{http_code}" -X POST https://qianfan.baidubce.com/v2/tokenplan/personal/v1/chat/completions -H "Authorization: Bearer %QIANFAN_KEY%" -H "Content-Type: application/json" -d "{\"model\":\"qianfan-code-latest\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":5}" --noproxy "*" -m 15 -o NUL
echo.

echo === PROXY 57321 qianfan-code-latest ===
curl.exe -w "\nPROXY: %%{time_total}s %%{http_code}" -X POST http://127.0.0.1:57321/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"qianfan-code-latest\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":5}" --noproxy "*" -m 15 -o NUL
echo.

echo === PROXY 57322 qianfan-code-latest (codex-tee only) ===
curl.exe -w "\nPROXY_57322: %%{time_total}s %%{http_code}" -X POST http://192.168.124.6:57322/v1/chat/completions -H "Authorization: Bearer %QIANFAN_KEY%" -H "Content-Type: application/json" -d "{\"model\":\"qianfan-code-latest\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":5}" --noproxy "*" -m 15 -o NUL
echo.
