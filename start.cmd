@echo off
REM OpenGate 启动器（隐藏控制台窗口由 start.vbs 负责）
cd /d "%~dp0"
node server.mjs
