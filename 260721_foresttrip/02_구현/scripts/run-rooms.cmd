@echo off
rem foresttrip room-level query (login + goods detail)
rem Reads ID/PW from .env, logs in, captures insttId 0111 (Daegwallyeong) 2026-08-19 rooms.
rem NOTE: keep this file ASCII-only (no Korean) - chcp+Korean breaks cmd parsing.
cd /d "%~dp0"
echo Running foresttrip rooms query (login + goods detail)...
echo (Korean output below may look garbled in this window - that is OK, it is saved to run.log)
node src\poc.js rooms 2 0111 20260819 20260820 2 > run.log 2>&1
echo.
echo ---- run.log ----
type run.log
echo -----------------
echo Result files: artifacts\goods.html / goods.png (success) or artifacts\login.png (fail)
pause
