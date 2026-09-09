# Reparación de ventas, concurrencia y red implementada

Fecha de validación local: 2026-09-08.

Alcance de seguridad actualizado: no se desplegó código Web ni APK y no se ejecutaron migraciones. El 8 de septiembre de 2026 se desplegaron reglas e índices únicamente en `sandbox-pruebas`. No se leyó, escribió ni desplegó información en la base de producción `ai-studio-c55570ec-b91e-4564-addb-ad38305426a9`.

## 1. Problemas confirmados

- `completeTransaction` dependía de `saveAllData`, que comparaba y potencialmente reescribía colecciones no relacionadas con la venta.
- La venta, inventario, saldo del cliente y caja se guardaban en operaciones separadas; una falla intermedia podía dejar estado parcial.
- Un `Promise.race` de cuatro segundos clasificaba una operación lenta como desconexión y podía mostrar un resultado sin confirmación real.
- El historial completo se serializaba en `localStorage`; una excepción de cuota podía interferir antes de confirmar Firestore.
- El inventario usaba transacciones, pero convertía resultados negativos en cero y podía ocultar un sobreconsumo concurrente.
- La caja acumulaba movimientos en un arreglo dentro del documento principal y la apertura reemplazaba ese arreglo.
- Los listeners de ventas y movimientos descargaban históricos crecientes.
- Una fecha regional inválida podía caer silenciosamente en la fecha actual.
- Las ventas legacy sin `branchId` no aparecen en consultas filtradas por sucursal.
- Capacitor no tenía una señal nativa de cambios de red para revalidar Firestore al recuperar conectividad o volver de segundo plano.
- El archivo de índices no cubría las consultas compuestas reales.
- Devoluciones, abonos y surtidos podían mostrar éxito después de varias escrituras independientes.

## 2. Diferencias respecto al diagnóstico

- `applyStockDeltas` ya usaba `runTransaction`; el problema real no era la ausencia de transacción, sino el ajuste silencioso a cero y la separación respecto al checkout.
- `src/firebase.ts` ya contenía persistencia IndexedDB multi-pestaña y una selección local de `VITE_FIRESTORE_DATABASE_ID`. Se preservó ese cambio existente y se usó `.env.development.local` para `sandbox-pruebas`.
- Había varios listeners, pero no todos pertenecían al flujo crítico de ventas. Se acotaron los de ventas, caja y movimientos de inventario; no se alteraron listeners de catálogos necesarios para operar.
- La caché offline propia ya no era necesaria: la SDK Web de Firestore ya mantenía IndexedDB persistente. No se agregó otra dependencia de almacenamiento.
- Aunque el diagnóstico proponía empaquetar `dist/`, la operación real requiere que el APK sea un contenedor WebView del sitio en vivo. Se conservó `server.url = https://tamalescastillo.com`; los assets locales son solamente el requisito de build/sincronización de Capacitor.

## 3. Archivos modificados o creados

- `src/App.tsx`: checkout, caja, inventario, fechas, consultas, estados de conectividad y compatibilidad legacy.
- `src/lib/posSafety.ts`: parser legacy, rangos, almacenamiento local seguro y clasificación de errores.
- `src/lib/posSafety.test.ts`: pruebas unitarias del parser y errores.
- `src/firebase.ts`: se preservó la selección de base por entorno y la caché persistente existente.
- `firestore.rules`: validación de ventas, caja, ledger y auditoría.
- `firestore.indexes.json`: índices de consultas realmente usadas.
- `firebase.sandbox.json`: configuración explícita para validaciones en `sandbox-pruebas`.
- `capacitor.config.ts`, `android/app/capacitor.build.gradle` y `android/capacitor.settings.gradle`: WebView del sitio en vivo y plugin de red.
- `package.json` y `package-lock.json`: `@capacitor/network`, `firebase-admin` y comandos de prueba/migración.
- `scripts/migrate-legacy-sales.mjs`: corrección progresiva de `branchId` y `createdAt` legacy.
- `scripts/migrate-cash-transactions.mjs`: copia idempotente del arreglo legacy al ledger.
- `docs/FIRESTORE_RULES_AUDIT.json`: auditoría adversarial de reglas.

## 4. Correcciones implementadas

### Checkout

`commitSaleAtomically` crea la venta y, dentro de la misma transacción Firestore, descuenta inventario, actualiza saldo a crédito, ajusta caja, crea el movimiento del ledger y registra el evento de checkout exitoso. El identificador combina tiempo y `crypto.randomUUID()`. Si el documento de venta ya existe, el reintento se considera idempotente.

La interfaz conserva el carrito y no muestra éxito hasta que la transacción termina. No existe un timeout artificial de cuatro segundos. `PERMISSION_DENIED`, sesión, desconexión, contención, datos inválidos, cuota, caja cerrada y stock insuficiente reciben mensajes diferentes.

### Inventario y operaciones relacionadas

Los deltas se agregan por producto/sucursal, se leen en orden estable dentro de la transacción y se rechaza cualquier resultado negativo. Una venta concurrente del mismo producto provoca retry de Firestore y solo una puede consumir la última existencia.

Las devoluciones ahora cambian venta, restituyen stock, corrigen crédito y registran caja en una sola transacción. Los abonos cambian saldo y caja juntos, recalculando el saldo vivo. Los surtidos cambian existencias, costo/proveedor, caja y movimiento de inventario juntos.

### Fechas y almacenamiento local

Las ventas nuevas usan `createdAt` numérico como fuente canónica. El parser legacy reconoce ISO y variantes `DD/MM/YYYY` con `a.m./p.m.`; una fecha inválida queda sin periodo y nunca se convierte en "hoy".

`saveAllData` dejó de serializar catálogos e históricos operativos en `localStorage`. Las preferencias pequeñas restantes usan wrappers que absorben `QuotaExceededError`/indisponibilidad y nunca preceden una venta crítica. Firestore IndexedDB queda como caché operativa.

## 5. Decisiones arquitectónicas

- Se mantuvo Firestore directo para evitar una reescritura general, pero se concentró la unidad lógica de checkout en una transacción.
- Se mantuvieron consultas Web SDK estándar porque el POS necesita listeners y persistencia offline; el diagnóstico de edición Enterprise se consideró, pero la base de pruebas autorizada es Standard Native.
- El documento de caja es estado actual; sus movimientos son eventos append-only.
- Los datos del mes actual son operativos y en tiempo real. Meses anteriores son lecturas puntuales bajo demanda.
- La compatibilidad con ventas sin `branchId` se conserva temporalmente en Matriz mediante una lectura bajo demanda; el script elimina esa excepción de forma progresiva.
- El APK conserva intencionalmente `server.url = https://tamalescastillo.com`: las actualizaciones funcionales llegan por el despliegue Web existente y no requieren reinstalar cada terminal. El plugin nativo de red sigue disponible dentro de ese contenedor.

## 6. Cambios de Firestore

Modelo nuevo de caja:

```text
companies/{companyId}/cashRegisters/{branchId}
  isOpen, initialCash, currentCash, currentShiftId,
  openedAt, closedAt, lastTransactionId, updatedAt

companies/{companyId}/cashRegisters/{branchId}/transactions/{transactionId}
  type, amount, cashDelta, description, createdAt,
  branchId, shiftId, saleId, createdBy, balanceAfter
```

El arreglo `transactions` legacy se puede leer, pero el código nuevo no lo modifica. La interfaz fusiona ledger y arreglo legacy con claves deterministas para evitar duplicados durante la migración.

Las ventas nuevas requieren `branchId`, `createdAt` numérico y estado `Completed`. El evento `success` de checkout y el movimiento de caja `Venta` se correlacionan con la venta creada en la misma operación.

## 7. Índices agregados

- `sales`: `branchId ASC, createdAt DESC`.
- `sales`: `branchId ASC, status ASC, createdAt DESC`.
- `stockMovements`: `branchId ASC, createdAt DESC`.
- `stockMovements`: `transferId ASC, type ASC`.

No se agregaron índices especulativos. La configuración compiló en dry-run y los cuatro índices se desplegaron posteriormente en `sandbox-pruebas`.

## 8. Reglas modificadas

- Denegación global por defecto y membresía por empresa conservadas.
- Ventas nuevas validadas y mutaciones posteriores limitadas a estado/facturación según rol.
- Documento principal de caja sin crecimiento del arreglo legacy.
- Cambio de saldo de caja obligatorio junto con un ledger correlacionado mediante `getAfter`.
- Ledger limitado por tipo, rango, longitud, sucursal y `createdBy`; no se puede editar ni borrar.
- `Venta` en ledger exige venta coincidente en la misma sucursal y por el mismo total.
- Evento de checkout inmutable, ligado al usuario; `success` exige la venta correspondiente.
- Auditoría completa y riesgos residuales en `docs/FIRESTORE_RULES_AUDIT.json`.

## 9. Migraciones creadas

Ambas usan Application Default Credentials, apuntan por defecto a `sandbox-pruebas`, son dry-run por defecto, procesan lotes seguros y exigen confirmaciones distintas para producción.

- `migrate:legacy-sales`: pagina ventas en bloques de 500; asigna Matriz solo si falta `branchId`; agrega `createdAt` solo si la fecha regional se puede interpretar; reporta fechas inválidas.
- `migrate:cash-ledger`: crea IDs deterministas `LEGACY-{createdAt}-{index}`, omite documentos ya copiados y nunca elimina el arreglo original.

No se ejecutó ninguna migración, ni siquiera en sandbox, porque requiere elegir un `companyId` real y revisar primero el conteo.

## 10. Comandos manuales pendientes

Sustituir `<COMPANY_ID>` y revisar toda salida antes de agregar `--apply`.

```powershell
# 1) Dry-run de ventas legacy en sandbox-pruebas
npm run migrate:legacy-sales -- --company=<COMPANY_ID> --database=sandbox-pruebas

# 2) Aplicar solo después de revisar muestras/conteos en sandbox
npm run migrate:legacy-sales -- --company=<COMPANY_ID> --database=sandbox-pruebas --apply

# 3) Dry-run y aplicación del ledger en sandbox
npm run migrate:cash-ledger -- --company=<COMPANY_ID> --database=sandbox-pruebas
npm run migrate:cash-ledger -- --company=<COMPANY_ID> --database=sandbox-pruebas --apply
```

El 8 de septiembre de 2026 se validaron y desplegaron las reglas e índices exclusivamente en `sandbox-pruebas`, usando `firebase.sandbox.json`. No se desplegaron en producción. Cualquier migración o despliegue de producción continúa pendiente y debe realizarse manualmente en una ventana controlada. Los scripts bloquean `--apply` en producción salvo que también se entregue el token de confirmación mostrado por el propio script. No se recomienda ejecutar esos comandos hasta respaldar/exportar y aprobar esta revisión.

```powershell
# Validación sin despliegue, segura para repetir contra sandbox
npx firebase-tools deploy --only firestore:rules,firestore:indexes --dry-run --project gen-lang-client-0749443687 --config firebase.sandbox.json

# Despliegue a sandbox: EJECUTADO correctamente el 8 de septiembre de 2026
npx firebase-tools deploy --only firestore:rules,firestore:indexes --project gen-lang-client-0749443687 --config firebase.sandbox.json

# Despliegue a producción: PENDIENTE, ejecutar manualmente solo tras aprobación
npx firebase-tools deploy --only firestore:rules,firestore:indexes --project gen-lang-client-0749443687 --config firebase.json
```

El deployment Web y la publicación del APK también quedan pendientes deliberadamente.

## 11. Pruebas ejecutadas

- `npm test`.
- `npm run lint` (`tsc --noEmit`).
- `node --check` sobre ambos scripts de migración.
- `npx firebase-tools ... --dry-run ... --config firebase.sandbox.json`.
- `npm run cap:sync` (incluye build Vite y sincronización de Android).
- `android/gradlew.bat assembleDebug --no-daemon`.
- `git diff --check`.

## 12. Resultados

- 5 pruebas unitarias aprobadas, 0 fallidas.
- TypeScript sin errores.
- Ambos scripts con sintaxis válida.
- Reglas compiladas, aceptadas en dry-run y desplegadas correctamente en `sandbox-pruebas`; índices desplegados y posteriormente verificados desde la aplicación local.
- Build Web/Capacitor correcto. Vite conserva una advertencia previa de bundle principal mayor a 500 kB.
- Sincronización Android correcta; `@capacitor/network` detectado.
- APK debug compilado correctamente en `android/app/build/outputs/apk/debug/app-debug.apk`.
- Gradle muestra advertencias no bloqueantes existentes sobre `flatDir`, versiones de herramientas SDK y APIs de plugins deprecadas.

## 13. Riesgos pendientes

- Hace falta una prueba funcional autenticada con dos terminales reales contra `sandbox-pruebas`; la compilación y el dry-run no sustituyen una prueba de contención end-to-end.
- Los reportes `all` pueden ser costosos por definición. Los listeners operativos están limitados a 2,000 documentos del mes; el histórico se solicita solo al abrir reportes.
- Matriz mantiene una lectura completa bajo demanda para descubrir ventas sin `branchId` hasta ejecutar la migración.
- La transacción admite hasta 450 productos distintos para conservar margen bajo el límite de escrituras; ventas anormalmente grandes se rechazan con un mensaje explícito.
- La auditoría de reglas obtuvo 3/5: no hay bypass entre empresas identificado, pero un cliente Firestore directo no puede imponer de forma completa todos los invariantes de cada partida. Para endurecimiento máximo, el checkout debería pasar por una función/API confiable.
- Los movimientos de auditoría de traspasos se escriben después de la transacción de stock; una falla excepcional del log no revierte el inventario. No afecta caja/venta, pero debe vigilarse si se exige auditoría contable total de traspasos.
- `npm install` reportó vulnerabilidades en el árbol de dependencias. No se ejecutó `npm audit fix` porque podría introducir cambios incompatibles fuera de este incidente.

## 14. Rollback

- El despliegue realizado solo afectó reglas e índices de `sandbox-pruebas`; no modificó documentos ni datos de producción.
- Para revertir la aplicación, desplegar el build Web/APK anterior. No borrar la subcolección `transactions`: las versiones nuevas y la migración son aditivas.
- Si se desplegaron reglas/índices y aparece una incompatibilidad, volver a desplegar la revisión anterior de `firestore.rules`/`firestore.indexes.json`; conservar los documentos del ledger.
- Si se aplicó una migración, no ejecutar borrados masivos. `branchId`/`createdAt` agregados son compatibles con versiones anteriores y el ledger es una copia; el arreglo legacy permanece intacto.
- Antes de cualquier operación de producción, exportar Firestore y registrar la revisión exacta de reglas, índices y aplicación desplegada.

## Matriz de escenarios verificados por diseño

| Caso | Resultado esperado con esta implementación |
|---|---|
| Venta normal | Solo muestra éxito tras commit de venta, stock, caja y auditoría. |
| Dos terminales, mismo producto | Firestore reintenta; la segunda transacción ve stock vivo y se rechaza si ya no alcanza. |
| Dos terminales, productos distintos | Transacciones independientes; comparten caja y Firestore reintenta el documento de caja si coincide el tiempo. |
| Red tarda 8 segundos | Permanece en `Confirmando`; no existe timeout falso de cuatro segundos. |
| Red se pierde durante venta | La transacción no confirma, el carrito permanece y el mensaje indica desconexión. |
| Android bloqueado/desbloqueado | `visibilitychange` vuelve a comprobar Firestore antes de habilitar cobro. |
| `localStorage` lleno | Las preferencias fallan de forma aislada; checkout no serializa históricos locales. |
| `PERMISSION_DENIED` | Mensaje de permisos/sesión; no se afirma que sea conectividad. |
| `ABORTED` | Mensaje de contención y carrito conservado. |
| Más de 10,000 ventas | Listener operativo solo del mes y con límite; histórico bajo demanda. |
| Miles de movimientos de caja | Cada movimiento es documento; el registro principal permanece acotado. |
| Reporte anterior | Consulta puntual por rango numérico `createdAt`. |
| Venta sin `branchId` | Compatibilidad Matriz bajo demanda y script dry-run de migración. |
| Fecha regional legacy | Parser controlado; las inválidas no se imputan al día actual. |
