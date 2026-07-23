@echo off
if "%QIANFAN_KEY%"=="" (
    echo Error: QIANFAN_KEY environment variable not set
    exit /b 1
)
for /l %%i in (1,1,5) do (
    curl.exe -s -X POST http://192.168.124.6:57322/v1/chat/completions -H "Authorization: Bearer %QIANFAN_KEY%" -H "Content-Type: application/json" -d "{\"model\":\"qianfan-code-latest\",\"messages\":[{\"role\":\"user\",\"content\":\"p\"}],\"max_tokens\":3}" --noproxy "*" -m 15 -o NUL
)
echo done
