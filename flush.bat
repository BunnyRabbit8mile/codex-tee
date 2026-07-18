@echo off
set KEY=REDACTED
for /l %%i in (1,1,5) do (
    curl.exe -s -X POST http://127.0.0.1:57322/v1/chat/completions -H "Authorization: Bearer %KEY%" -H "Content-Type: application/json" -d "{\"model\":\"deepseek-v4-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"p\"}],\"max_tokens\":3}" --noproxy "*" -m 15 -o NUL
)
echo done
