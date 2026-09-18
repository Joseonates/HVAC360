@echo off
chcp 65001 >nul
cd /d "%~dp0"
cls
echo.
echo   HVAC 360 - Paso 2: publicar las reglas de seguridad
echo   ==================================================
echo.
echo   Proyecto: hvac360
echo.
echo   Esto sube a Firebase las reglas que pasaron las 45
echo   pruebas, y los indices de consulta.
echo.
echo   No cierre esta ventana.
echo.

set LOG=resultado-publicacion.txt
echo HVAC 360 - Publicacion de reglas > "%LOG%"
echo Fecha: %DATE% %TIME% >> "%LOG%"
echo. >> "%LOG%"

call npx firebase deploy --only firestore:rules,firestore:indexes --project hvac360 >> "%LOG%" 2>&1
type "%LOG%"

echo.
echo   ==================================================
echo   Termino. Cierre esta ventana y avisele a Claude.
echo   ==================================================
echo.
pause
