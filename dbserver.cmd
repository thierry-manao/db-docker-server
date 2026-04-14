@echo off
setlocal
set "SCRIPT_DIR=%~dp0"

REM Try native bash first (Git Bash / MSYS2), fall back to WSL
where bash >nul 2>nul && where docker >nul 2>nul && (
    bash "%SCRIPT_DIR%scripts\dbserver.sh" %*
    goto :eof
)
wsl bash "%SCRIPT_DIR%scripts\dbserver.sh" %*
