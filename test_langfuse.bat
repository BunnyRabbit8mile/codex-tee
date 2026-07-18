@echo off
set KEY=sk-1bc4f55884dd40b0b6ce28726723b0ef
curl.exe -s -w "\nHTTP:%%{http_code}" -X POST http://127.0.0.1:57322/v1/chat/completions -H "Authorization: Bearer %KEY%" -H "Content-Type: application/json" -d "{\"model\":\"deepseek-v4-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"say test\"}],\"max_tokens\":5}" --noproxy "*" -m 15
echo.
