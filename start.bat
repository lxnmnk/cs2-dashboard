@echo off
setlocal

cd /d "%~dp0"

echo ==========================================
echo   CS2 Price Dashboard - starting
echo ==========================================
echo.

REM --- Check Node.js is installed ---
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo Download and install it from https://nodejs.org/  (LTS version)
    echo After installing, RESTART your computer or close all console windows,
    echo then run this file again.
    echo.
    pause
    exit /b 1
)

node -v
echo.

REM --- Check .env exists ---
if not exist ".env" (
    if exist ".env.example" (
        echo [!] .env not found. Creating it from .env.example ...
        copy ".env.example" ".env" >nul
        echo.
        echo [!] Open the .env file that just opened in Notepad,
        echo [!] paste your cs2.sh API key instead of the placeholder,
        echo [!] save the file, close Notepad, then run start.bat again.
        echo.
        notepad ".env"
        pause
        exit /b 0
    ) else (
        echo [ERROR] Neither .env nor .env.example was found.
        pause
        exit /b 1
    )
)

REM --- Check API key was actually filled in ---
findstr /C:"paste_your_cs2sh_api_key_here" ".env" >nul
if not errorlevel 1 (
    echo [!] .env still has the placeholder instead of a real cs2.sh API key.
    echo [!] Opening .env for editing ...
    notepad ".env"
    pause
    exit /b 0
)

REM --- Install dependencies on first run ---
if not exist "node_modules" (
    echo [*] First run detected - installing dependencies with npm install ...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. See the messages above.
        pause
        exit /b 1
    )
    echo.
)

echo [*] Starting server...
echo [*] Dashboard will be available at: http://localhost:3000
echo [*] To stop the server, close this window or press Ctrl+C
echo.

call npm start

echo.
echo [*] Server stopped.
pause
