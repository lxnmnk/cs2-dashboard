@echo off
setlocal

cd /d "%~dp0"

echo ==========================================
echo   CS2 Price Dashboard - update
echo ==========================================
echo.

REM --- Figure out which zip to use ---
REM Usage 1: drag-and-drop the new cs2-dashboard.zip onto this file
REM Usage 2: just double-click, it will look in your Downloads folder
set "ZIP=%~1"
if "%ZIP%"=="" set "ZIP=%USERPROFILE%\Downloads\cs2-dashboard.zip"

if not exist "%ZIP%" (
    echo [ERROR] Could not find zip file: %ZIP%
    echo.
    echo Either drag the new cs2-dashboard.zip file onto update.bat,
    echo or save it as: %USERPROFILE%\Downloads\cs2-dashboard.zip
    echo.
    pause
    exit /b 1
)

echo [*] Using archive: %ZIP%
echo.

set "TMP_DIR=%TEMP%\cs2-dashboard-update"
if exist "%TMP_DIR%" rmdir /s /q "%TMP_DIR%"
mkdir "%TMP_DIR%"

echo [*] Extracting archive...
powershell -NoProfile -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%TMP_DIR%' -Force"
if errorlevel 1 (
    echo [ERROR] Failed to extract the zip file.
    pause
    exit /b 1
)

set "SRC=%TMP_DIR%\cs2-dashboard"
if not exist "%SRC%" (
    echo [ERROR] Unexpected archive structure - "cs2-dashboard" folder not found inside the zip.
    pause
    exit /b 1
)

echo [*] Copying updated files into this folder...
echo [*] Your .env and node_modules are kept untouched.
echo.
robocopy "%SRC%" "%~dp0" /E /XF .env /XD node_modules

echo.
echo [*] Checking / installing dependencies...
call npm install

rmdir /s /q "%TMP_DIR%" >nul 2>nul

echo.
echo ==========================================
echo   Update complete!
echo   Run start.bat (or npm start) to launch.
echo ==========================================
pause
