@echo off
cd /d "%~dp0"
set Port=5012

python -c "import socket,sys; s=socket.socket(); s.settimeout(1); sys.exit(0 if s.connect_ex(('127.0.0.1',%Port%))==0 else 1)" >nul 2>&1
if not errorlevel 1 (
    echo Something is already listening on port %Port%, so the server is probably running at http://127.0.0.1:%Port%
    echo Not starting a second instance. Close the other window first, or change the Port in run.bat.
    pause
    exit /b 1
)

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
