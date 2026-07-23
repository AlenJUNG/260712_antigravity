@echo off
rem foresttrip rooms-nation : ALL provinces, check-in 2026-08-01 (Sat), 1 night, 2 people
rem Reads ID/PW from .env, logs in headless, scans every forest nationwide (~15-20 min).
rem Keep this file ASCII-only.
cd /d "%~dp0"
echo Running rooms-nation: ALL Korea 2026-08-01 ~ 08-02 (takes ~15-20 min, please wait)...
node src\poc.js rooms-nation 20260801 20260802 2 > run-nation.log 2>&1
echo.
echo Done. Result: artifactsooms-region.json  (log: run-nation.log)
type run-nation.log
pause
