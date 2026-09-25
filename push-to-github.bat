@echo off
cls
echo ===================================================
echo   GatherSync - GitHub Upload Tool
echo ===================================================
echo.
set "GIT_EXE=C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\TeamFoundation\Team Explorer\Git\cmd\git.exe"

set "DEFAULT_URL=https://github.com/hito0810/gethersync.git"
echo Default URL: %DEFAULT_URL%
set /p REPO_URL="Enter GitHub Repository URL [Press Enter for default]: "

if "%REPO_URL%"=="" (
    set "REPO_URL=%DEFAULT_URL%"
)

echo.
echo [1/3] Adding files...
"%GIT_EXE%" config user.name "GatherSync User"
"%GIT_EXE%" config user.email "user@gathersync.local"
"%GIT_EXE%" add .
"%GIT_EXE%" commit -m "Update GatherSync files for cloud hosting" --allow-empty

echo.
echo [2/3] Setting remote...
"%GIT_EXE%" remote remove origin >nul 2>&1
"%GIT_EXE%" remote add origin %REPO_URL%
"%GIT_EXE%" branch -M main

echo.
echo [3/3] Uploading to GitHub...
"%GIT_EXE%" push -u origin main

if %ERRORLEVEL% equ 0 (
    echo.
    echo ===================================================
    echo   SUCCESS: Uploaded to GitHub successfully!
    echo ===================================================
) else (
    echo.
    echo [ERROR] Failed to upload. Please check your URL / GitHub login.
)

:END
echo.
pause