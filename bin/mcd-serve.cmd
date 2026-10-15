@echo off
chcp 65001 >nul
rem ---------------------------------------------------------------
rem  双击入口：启动「手机端服务」。
rem
rem  它会做三件事：
rem    1) 在电脑上启动一个网页服务（默认 8787 端口）；
rem    2) 打印一个「手机上打开」的地址（带访问码）；
rem    3) 顺手在电脑浏览器里打开同一个界面，方便你确认没问题。
rem
rem  用法：
rem    mcd-serve.cmd              真实 Token（读取 mcp-config.json）
rem    mcd-serve.cmd --demo       离线演示，不联网、不需要 Token
rem    mcd-serve.cmd --port 9000  换端口
rem
rem  贴心提示：如果弹不出浏览器，请手动复制窗口里打印的地址。
rem  关闭这个黑窗口 = 停止服务。
rem ---------------------------------------------------------------
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] 没有找到 Node.js。
  echo       请先到 https://nodejs.org 下载安装 LTS 版本，装完重新双击本文件。
  echo.
  pause
  exit /b 1
)

node "src\server.mjs" --open %*
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo   [X] 服务异常退出（代码 %EXITCODE%）。常见原因：
  echo       - 没有 Token：先双击 bin\mcd-demo.cmd 看看界面长什么样，或复制
  echo         mcp-config.example.json 为 mcp-config.json 并填入真实 Token。
  echo       - 端口被占用：换一个端口重试，例如  mcd-serve.cmd --port 9000
)
echo   服务已停止。按任意键关闭窗口。
pause >nul
