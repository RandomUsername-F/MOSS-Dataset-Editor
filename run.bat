@echo off
cd /d "%~dp0"
set Port=5012

python -c "import flask, PIL" >nul 2>&1
if errorlevel 1 (
    echo Installing flask and pillow...
    python -m pip install flask pillow
    if errorlevel 1 (
        echo Install failed.
        pause
        exit /b 1
    )
)

echo Serving at http://127.0.0.1:%Port%
python server.py --port %Port%
pause
