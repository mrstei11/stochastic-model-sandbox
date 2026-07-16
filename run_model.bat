@echo off
REM ============================================================
REM  MIM Stochastic Model - restart and open dashboard
REM  Kills anything on port 8051, starts sm_python.py in a new
REM  console window, waits for the API, then opens Chrome.
REM ============================================================
cd /d "%~dp0"

echo Stopping any existing model server on port 8051...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8051" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%p >nul 2>&1
)

echo Starting model (simulations take about a minute)...
start "MIM Stochastic Model" "%~dp0.venv\Scripts\python.exe" "%~dp0sm_python.py"

echo Waiting for the API to come up...
set /a tries=0
:wait
set /a tries+=1
if %tries% gtr 100 (
    echo Model failed to start after 5 minutes - check the model window for errors.
    pause
    exit /b 1
)
timeout /t 3 /nobreak >nul
curl -s -o nul http://localhost:8051/api/property-types 2>nul
if errorlevel 1 goto wait

echo Opening dashboard...
start chrome "http://localhost:8051" 2>nul
if errorlevel 1 start "" "http://localhost:8051"
echo Dashboard running at http://localhost:8051
