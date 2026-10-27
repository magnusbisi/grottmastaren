@echo off
title Grottmastaren - natverksspel
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js saknas pa den har datorn.
  echo   Ladda ner och installera "LTS" fran https://nodejs.org och starta sedan den har filen igen.
  echo.
  pause
  exit /b
)
node "%~dp0server.js" %*
pause
