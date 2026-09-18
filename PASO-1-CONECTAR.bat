@echo off
chcp 65001 >nul
cd /d "%~dp0"
cls
echo.
echo   HVAC 360 - Paso 1: conectar con su cuenta de Firebase
echo   ====================================================
echo.
echo   Van a pasar dos cosas:
echo.
echo   1. Le pregunta si permite enviar estadisticas de uso.
echo      Responda N y pulse Enter (da igual, pero N es mas discreto).
echo.
echo   2. Se abre el navegador para que entre con su cuenta de Google.
echo      Elija la misma cuenta donde creo el proyecto hvac360.
echo.
echo   ----------------------------------------------------
echo.
pause

call npx firebase login

echo.
echo   Buscando sus proyectos...
echo.
call npx firebase projects:list > lista-proyectos.txt 2>&1
type lista-proyectos.txt

echo.
echo   ====================================================
echo   LISTO. Cierre esta ventana y avisele a Claude.
echo   ====================================================
echo.
pause
