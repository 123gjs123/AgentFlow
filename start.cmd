@echo off
cd /d "%~dp0"
rem Opens the UI with its access key (printed by the server too), then runs the server.
for /f "usebackq delims=" %%u in (`node bin\afs.js ui --print`) do set "AFS_UI_URL=%%u"
start "" "%AFS_UI_URL%"
node server/index.js
