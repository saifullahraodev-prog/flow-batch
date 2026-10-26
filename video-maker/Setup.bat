@echo off
rem One-time setup for Make Video on a new PC: Python, FFmpeg, faster-whisper
rem and the speech model. Safe to run again - it skips what is already there.
setlocal
cd /d "%~dp0"
set PYTHONDONTWRITEBYTECODE=1
set HF_HUB_DISABLE_XET=1

echo.
echo ===== Make Video setup =====
echo.

rem ---- 1. Python ----
python --version >nul 2>&1
if errorlevel 1 (
    echo [1/4] Python not found - installing it...
    winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
    echo.
    echo Python was installed. CLOSE this window and double-click Setup.bat again
    echo so Windows picks up the new Python.
    echo.
    pause
    exit /b 0
)
for /f "delims=" %%v in ('python --version') do echo [1/4] %%v found.

rem ---- 2. FFmpeg ----
python -B -c "import sys, make_video; sys.exit(0 if make_video.find_tool('ffmpeg') else 1)" >nul 2>&1
if errorlevel 1 (
    echo [2/4] FFmpeg not found - installing it...
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
    python -B -c "import sys, make_video; sys.exit(0 if make_video.find_tool('ffmpeg') else 1)" >nul 2>&1
    if errorlevel 1 (
        echo     FFmpeg install did not work. Install it by hand: winget install Gyan.FFmpeg
        pause
        exit /b 1
    )
)
echo [2/4] FFmpeg is installed.

rem ---- 3. faster-whisper ----
echo [3/4] Installing the speech library (faster-whisper)...
python -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 (
    echo     pip install failed - check your internet connection and run Setup.bat again.
    pause
    exit /b 1
)
echo [3/4] Speech library installed.

rem ---- 4. speech model ----
echo [4/4] Downloading the speech model (~480 MB, only the first time)...
python -B -c "import make_video; from faster_whisper import WhisperModel; WhisperModel(make_video.WHISPER_MODEL, device='cpu', compute_type='int8'); print('[4/4] Speech model ready.')"
if errorlevel 1 (
    echo     Model download failed - check your internet connection and run Setup.bat again.
    pause
    exit /b 1
)

echo.
echo ===== All set! Double-click "Make Video.bat" to make a video. =====
echo.
pause
