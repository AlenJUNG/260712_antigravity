@echo off
rem One-time: log in with .env and SAVE the session to auth.json.
rem After this, Claude can scan without re-login (faster, remote-friendly).
cd /d "%~dp0"
echo Logging in and saving session (headless, ~15s)...
node src\poc.js login-save > run-login.log 2>&1
type run-login.log
echo.
echo If it says "auth.json saved" above, tell Claude "done".
pause
