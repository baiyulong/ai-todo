@echo off
rem ============================================================
rem  AI Todo 服务启动脚本（Windows）
rem  双击即可运行。关闭本窗口 = 停止服务。
rem ============================================================
setlocal

rem Node 默认不在 PATH 里，这里显式补上
set "NODE_DIR=%ProgramFiles%\nodejs"
set "PATH=%NODE_DIR%;%PATH%"

cd /d "%~dp0.."

if not exist "%NODE_DIR%\node.exe" (
  echo [错误] 找不到 Node.js：%NODE_DIR%\node.exe
  echo 请先安装 Node.js 20.10+ ，或修改本脚本里的 NODE_DIR。
  pause
  exit /b 1
)

if not exist "dist\src\cli.js" (
  echo [提示] 还没编译，先执行 build ...
  call "%NODE_DIR%\npm.cmd" run build
  if errorlevel 1 (
    echo [错误] 编译失败。
    pause
    exit /b 1
  )
)

echo.
echo   AI Todo 正在启动 ...
echo   关闭本窗口即可停止服务。
echo.

"%NODE_DIR%\node.exe" "dist\src\cli.js" serve

echo.
echo   服务已停止。
pause
