@echo off
rem Double-click to open the Make Video tool.
rem Uses the same Python that Setup.bat installed the speech library into
rem (the "python" on PATH), started without a console window (pythonw.exe).
setlocal
cd /d "%~dp0"
set "PYW="
for /f "delims=" %%p in ('python -c "import sys, os; print(os.path.join(os.path.dirname(sys.executable), 'pythonw.exe'))" 2^>nul') do set "PYW=%%p"
if defined PYW if exist "%PYW%" (
    start "" "%PYW%" -B "%~dp0make_video.py"
    exit /b 0
)
rem Fallback: run with a console window so any error stays visible.
python -B "%~dp0make_video.py"
if errorlevel 1 pause
