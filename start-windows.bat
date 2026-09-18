@echo off
REM Sets FFmpeg/ffprobe paths explicitly (bypasses Windows PATH issues)
REM and starts the server. Edit the two paths below if your FFmpeg
REM install location ever changes.

set FFMPEG_PATH=C:\Users\vbhar\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-full_build\bin\ffmpeg.exe
set FFPROBE_PATH=C:\Users\vbhar\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-full_build\bin\ffprobe.exe

echo Using FFmpeg:  %FFMPEG_PATH%
echo Using ffprobe: %FFPROBE_PATH%
echo.

if not exist "%FFMPEG_PATH%" (
  echo WARNING: ffmpeg.exe not found at that path. Update FFMPEG_PATH in this file.
)
if not exist "%FFPROBE_PATH%" (
  echo WARNING: ffprobe.exe not found at that path. Update FFPROBE_PATH in this file.
)

npm start
