@echo off
rem Starts the Mini App server and its HTTPS tunnel in the background.
rem Logs: data\server.log (output) and data\server.err.log (errors).
cd /d "%~dp0"
set PYTHONUNBUFFERED=1
start "msu-server" /min python -X utf8 run.py 1>data\server.log 2>data\server.err.log
echo Server is starting. The bot picks up the new address in about 30 seconds.
