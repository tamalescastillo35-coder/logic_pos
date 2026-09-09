# Preparación de salida a producción

**Proyecto:** LOGIC POS  
**Fecha:** 9 de septiembre de 2026  
**Rama preparada:** `release/production-readiness`  
**Repositorio de destino:** `tamalescastillo35-coder/logic_pos` (`upstream-client`)  
**Sitio en vivo:** `https://tamalescastillo.com`  
**Firestore productivo:** `ai-studio-c55570ec-b91e-4564-addb-ad38305426a9`  
**Firestore de pruebas:** `sandbox-pruebas`

## Estado de preparación

- La rama parte del `main` más reciente del repositorio del cliente (`1aa6532`).
- El cambio remoto que conservaba un contador de ventas offline quedó superado intencionalmente por el checkout atómico actual: una venta sin conexión ya no se declara aceptada ni queda en una cola ambigua; el carrito permanece intacto hasta que Firestore confirma toda la transacción.
- La aplicación local apunta a `sandbox-pruebas`; ninguna validación de esta preparación escribió datos ni publicó configuración en producción.
- `firebase.production.json` fija explícitamente la base productiva para evitar confundirla con el sandbox.
- `scripts/verify-production-config.mjs` impide compilar una liberación si aparece `VITE_FIRESTORE_DATABASE_ID`, si la Web deja de apuntar a la base productiva o si Capacitor deja de cargar `https://tamalescastillo.com`.
- La transferencia de propiedad quedó alineada con las reglas: el cambio de empresa, el ascenso del nuevo dueño y la degradación del anterior deben confirmarse juntos en un solo lote.
- `.cx/` está excluido del repositorio porque contiene estado local de herramientas, no código del producto.
- `scripts/load-tamales-castillo.mjs` permanece disponible solo localmente y está excluido del repositorio porque contiene un procedimiento de aprovisionamiento con accesos previsibles.

## Flujo Web/VPS preparado

El archivo `.github/workflows/deploy.yml` conserva el despliegue automático al VPS cuando se actualiza `main`, pero agrega barreras previas:

1. instalación reproducible con `npm ci`;
2. verificación de configuración productiva;
3. pruebas unitarias;
4. validación TypeScript;
5. compilación completa;
6. exclusión de despliegues simultáneos;
7. acciones de GitHub fijadas por identificador inmutable;
8. compilación reproducible en el VPS;
9. reinicio de PM2;
10. comprobación HTTP local con reintentos durante el arranque;
11. restauración automática de la revisión anterior si falla la comprobación.

El workflow sigue usando la cuenta `root` del VPS porque es la credencial existente. Como mejora posterior conviene crear un usuario de despliegue con permisos limitados.

## Verificación previa local

Ejecutar desde la raíz:

```powershell
npm ci
npm run verify:production
npm run firebase:check:production
```

El tercer comando es solamente un `dry-run`: compila reglas e índices contra la configuración productiva, pero no los publica.

Resultados del candidato preparado:

- configuración productiva: aprobada;
- pruebas unitarias: 10 de 10 aprobadas;
- TypeScript: aprobado;
- compilación Web y servidor: aprobada;
- reglas e índices Firestore: compilación aprobada en `dry-run`;
- dependencias de producción: `npm audit --omit=dev` sin vulnerabilidades conocidas;
- sintaxis YAML/JSON del despliegue y Firebase: aprobada.

## Orden de liberación recomendado

1. Confirmar la prueba móvil autenticada y la matriz de permisos de un empleado real en `sandbox-pruebas`.
2. Revisar los commits locales y publicar la rama `codex/production-readiness` en el repositorio del cliente.
3. Abrir un pull request hacia `main` y esperar que pase `Verify release candidate`.
4. Respaldar/exportar Firestore productivo antes de cualquier migración. Las migraciones incluidas no deben ejecutarse automáticamente.
5. Publicar primero reglas e índices con el comando explícito de la sección siguiente.
6. Fusionar el pull request a `main`; esto activa el despliegue Web al VPS.
7. Comprobar `https://tamalescastillo.com`, inicio de sesión, sucursal, inventario, caja y una venta de humo controlada.
8. Confirmar que el APK existente abre la nueva Web, porque funciona como WebView del sitio en vivo.

## Comandos productivos — requieren autorización final

Publicar reglas e índices en la base productiva:

```powershell
npx -y firebase-tools@latest deploy --only firestore:rules,firestore:indexes --project gen-lang-client-0749443687 --config firebase.production.json
```

Publicar la rama de preparación, después de revisar los commits:

```powershell
git push -u upstream-client codex/production-readiness
```

No se debe hacer push directo a `main`; la fusión del pull request es la acción que dispara el despliegue productivo.

## Reversión

### Web/VPS

El workflow guarda la revisión anterior y la restaura automáticamente si el servicio recién desplegado no responde localmente. Si el sitio responde pero presenta una regresión funcional, revertir el commit de fusión en GitHub; el nuevo push a `main` volverá a desplegar la versión anterior.

### Reglas de Firestore

Antes de publicar, conservar el hash del commit que contiene las reglas actualmente activas. Para volver atrás, seleccionar esa revisión de `firestore.rules` y `firestore.indexes.json`, repetir el `dry-run` y desplegar usando `firebase.production.json`.

### Datos

No ejecutar `migrate:legacy-sales` ni `migrate:cash-ledger` en producción durante el despliegue inicial. Cualquier migración debe hacerse después, con respaldo, dry-run, conteo de documentos y ventana separada.

## Bloqueos restantes para declarar “listo para producción”

1. Prueba autenticada en móvil real o emulación completa.
2. Prueba con una cuenta de empleado para confirmar permisos permitidos y denegados.
3. Confirmar en GitHub que el environment `production` permite ejecutar el job y conserva `SSH_PRIVATE_KEY`.
4. Realizar respaldo de Firestore productivo antes del cambio de reglas o de futuras migraciones.

Hasta completar estos puntos, la rama está preparada técnicamente, pero no debe fusionarse a `main`.
