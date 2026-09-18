@echo off
chcp 65001 >nul
cd /d "%~dp0"
cls
set LOG=resultado-pruebas.txt

echo.
echo   HVAC 360 - Pruebas (version gratuita)
echo   ====================================
echo.
echo   No cierre esta ventana.
echo.

echo HVAC 360 - Resultado de las pruebas > "%LOG%"
echo Fecha: %DATE% %TIME% >> "%LOG%"
echo. >> "%LOG%"
echo ===== JAVA ===== >> "%LOG%"
java -version >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo   [1 de 2] Instalando dependencias...
echo ===== NPM INSTALL ===== >> "%LOG%"
call npm install --no-audit --no-fund >> "%LOG%" 2>&1

echo   [2 de 2] Ejecutando las pruebas...
echo. >> "%LOG%"
echo ===== PRUEBAS ===== >> "%LOG%"
call npm test >> "%LOG%" 2>&1

echo.
echo   ====================================
echo   LISTO. Cierre esta ventana y avisele
echo   a Claude que ya termino.
echo   ====================================
echo.
pause
