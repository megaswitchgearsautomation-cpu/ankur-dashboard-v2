@echo off
REM Ankur Dashboard v2 (new design) - runs on port 8082 so it never clashes with v1 (port 8080)
cd /d "%~dp0backend"
python run.py --port 8082 %*
pause
