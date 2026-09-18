# HVAC 360° · Fase 1.5 · Versión plan GRATUITO (Spark)

Esta es la misma base multiempresa de antes, reescrita para **no necesitar
plan Blaze ni tarjeta de crédito**.

## Qué cambió y por qué

Lo único que obligaba a contratar Blaze eran las Cloud Functions. Se usaban
para una sola cosa importante: escribir el rol del usuario dentro de su token
de acceso (custom claims), algo que solo puede hacer un servidor.

Ahora el rol vive en un documento de Firestore:

```
/tenants/{empresaId}/members/{uid}   →   { name, role, active, clientId? }
```

Las reglas de seguridad leen ese documento en cada operación. El efecto es el
mismo: el usuario no puede mentir sobre su rol, porque no puede escribir su
propia ficha.

| | Antes (Blaze) | Ahora (gratis) |
|---|---|---|
| Dónde vive el rol | En el token | En Firestore |
| Quién lo asigna | Cloud Functions | Un admin de la empresa, desde la app |
| Efecto de un cambio de rol | Al volver a iniciar sesión | Inmediato |
| Costo por operación | 0 lecturas extra | 1 o 2 lecturas extra |
| Requiere tarjeta | Sí | No |

Con el tope gratuito de 50.000 lecturas diarias, esas lecturas extra dan para
varios miles de operaciones al día. Una empresa de HVAC con 10 técnicos no se
acerca.

## Los candados que reemplazan a las funciones

- **Nadie puede editar su propia ficha de miembro.** Ni un técnico para
  ascenderse, ni un admin para desactivarse. Esto también evita que una empresa
  se quede sin administrador por un clic equivocado.
- **Solo un admin puede crear o modificar la ficha de otra persona**, y solo
  dentro de su propia empresa.
- **Registrar una empresa nueva** exige que quien la crea quede como admin en
  la misma operación, y que la empresa nazca en estado `prueba`.
- **El plan y el estado de la empresa no se tocan desde la app.** Eso lo cambia
  usted desde la consola de Firebase cuando alguien pague o deje de pagar.
- **Un miembro con `active: false` pierde el acceso inmediatamente.**

## Lo que quedó pendiente para cuando haya ingresos

- **Storage** (fotos, firmas, informes PDF de la Fase 2) sigue necesitando
  Blaze. No hace falta todavía.
- **Crear usuarios desde el panel de admin** requiere un truco del lado del
  navegador: se usa una segunda instancia de Firebase Auth para crear la cuenta
  sin cerrar la sesión del administrador. Se resuelve en la app, sin servidor.
- **Suspender una empresa por falta de pago** hoy se hace a mano en la consola.
  Cuando tenga varios clientes pagando, vale la pena automatizarlo con una
  función — y para entonces Blaze ya se paga solo.

## Cómo probar

Doble clic en `PROBAR.bat`. Escribe el resultado en `resultado-pruebas.txt`,
en esta misma carpeta.

## Cómo publicar (cuando las pruebas pasen)

```
npx firebase login
npx firebase use --add          (elija el proyecto hvac360)
npm run publicar-reglas
```

Los planes comerciales (`plans/basico`, `plans/profesional`, `plans/empresarial`)
se crean a mano desde la consola de Firebase, o con un script cuando haga falta.
