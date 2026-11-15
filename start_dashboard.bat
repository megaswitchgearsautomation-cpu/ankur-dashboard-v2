@echo off
REM Ankur Dashboard v3 (brief 14-11-2026) - runs on port 8083; v2 (previous) stays on 8082
cd /d "%~dp0backend"
python run.py --port 8083 %*
pause
