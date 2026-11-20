@echo off
setlocal
cd /d "%~dp0.."

rem Inno Setup 6 compiler. Override by setting the ISCC environment variable.
if "%ISCC%"=="" set "ISCC=D:\Claude\Inno Setup 6\ISCC.exe"

if not exist "%ISCC%" (
  echo.
  echo ERROR: Inno Setup was not found at %ISCC%
  echo Set the ISCC environment variable to your ISCC.exe path, e.g.
  echo   set ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe
  pause
  exit /b 1
)

rem Local Electron zip for offline packaging. Leave empty to let packager download.
rem Only use the local cache when it actually exists, so a fresh clone still works.
if "%ELECTRON_ZIP_DIR%"=="" if exist "D:\Claude\electron-cache\electron-v*-win32-x64.zip" set "ELECTRON_ZIP_DIR=D:\Claude\electron-cache"

echo.
echo [1/2] Rebuilding the app folder...
call npm run dist
if errorlevel 1 goto :failed

echo.
echo [2/2] Building the installer...
"%ISCC%" "installer\FolioPrism.iss"
if errorlevel 1 goto :failed

echo.
echo Done!
echo Installer output: %CD%\dist\release\
dir /b "dist\release\*setup.exe" 2>nul
pause
exit /b 0

:failed
echo.
echo FAILED. Please read the messages above.
pause
exit /b 1
