@echo off
setlocal

:: Sensor System Windows Setup Wrapper
:: This script bypasses PowerShell ExecutionPolicy for this session to run setup.ps1

echo [Sensor System Setup Wrapper]
echo Proceeding to run PowerShell setup script...

:: Check if PowerShell exists
powershell.exe -Command "Exit 0" >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] PowerShell is not found or failed to run.
    echo Please ensure PowerShell is installed and available in your PATH.
    pause
    exit /b 1
)

:: Run the script with ExecutionPolicy Bypass
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"

if %errorlevel% neq 0 (
    echo [ERROR] Setup script failed. Please check the output above for errors.
    pause
    exit /b 1
)

echo.
echo [Setup Successful]
echo You can now use the environment as instructed above.
pause
endlocal
