@echo off
rem TEST: Daegwallyeong(0111) 2026-08-01 with waitlist mode - quick verify (~30s)
cd /d "%~dp0"
echo Testing waitlist parse: Daegwallyeong 2026-08-01...
node src\poc.js rooms 2 0111 20260801 20260802 2 > run-test.log 2>&1
type run-test.log
echo Done. artifacts: goods.html (reserve) + goods-wtng.html (wait)
pause
