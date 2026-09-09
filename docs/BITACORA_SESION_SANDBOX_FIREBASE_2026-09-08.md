# Bitácora de sesión: reparación de ventas, Firebase y sandbox

**Proyecto:** LOGIC POS / Tamales Castillo  
**Fecha:** 8 de septiembre de 2026 (America/Mexico_City)  
**Repositorio local:** `swiftsale-pos-backup`  
**Proyecto Firebase:** `gen-lang-client-0749443687`  
**Base usada para pruebas:** `sandbox-pruebas`  
**Estado de producción:** no modificada

## 1. Objetivo de la sesión

Continuar la reparación descrita en `DIAGNOSTICO_ARQUITECTURA_VENTAS_CONCURRENCIA_Y_RED.md`, ejecutar el proyecto local contra una base segura, validar el comportamiento real y corregir los problemas encontrados sin escribir, migrar ni desplegar cambios en la base de producción.

La intervención abarcó:

- integridad y concurrencia del checkout;
- inventario y caja;
- fechas y datos legacy;
- listeners y consultas históricas;
- mensajes de conectividad;
- Capacitor/Android;
- reglas e índices de Firestore;
- ejecución local contra `sandbox-pruebas`;
- diagnóstico y corrección del error Firestore `b815/ca9`.

El detalle arquitectónico de la reparación principal se conserva en `REPARACION_VENTAS_CONCURRENCIA_IMPLEMENTADA.md`. Esta bitácora registra además las operaciones realizadas en Firebase y la verificación interactiva posterior.

## 2. Límites y medidas de seguridad

- Todas las pruebas y operaciones de Firebase se dirigieron a `sandbox-pruebas`.
- La base de producción `ai-studio-c55570ec-b91e-4564-addb-ad38305426a9` no fue usada para pruebas ni despliegues.
- No se ejecutaron migraciones de ventas o caja en ninguna base.
- No se borraron ventas, movimientos, colecciones ni cachés del navegador.
- No se desplegó el sitio Web.
- No se publicó ningún APK.
- No se realizó commit ni push a GitHub.
- Los archivos y cambios preexistentes del usuario se conservaron.

## 3. Entornos Firestore confirmados

La consulta de bases mediante Firebase CLI confirmó dos instancias distintas:

| Base | Edición | Tipo | Uso durante la sesión |
|---|---|---|---|
| `sandbox-pruebas` | Standard | Firestore Native | Pruebas locales y despliegue de reglas/índices |
| `ai-studio-c55570ec-b91e-4564-addb-ad38305426a9` | Enterprise | Firestore Native | Producción; no se modificó |

La aplicación local se vinculó al sandbox mediante:

```text
VITE_FIRESTORE_DATABASE_ID=sandbox-pruebas
```

Esta variable reside en `.env.development.local`, archivo ignorado por Git. `src/firebase.ts` respeta esta selección solo cuando la variable existe; los builds sin ella mantienen como fallback la base configurada originalmente para producción.

También se creó `firebase.sandbox.json`, que declara explícitamente:

- base: `sandbox-pruebas`;
- región: `us-east1`;
- reglas: `firestore.rules`;
- índices: `firestore.indexes.json`.

## 4. Reparaciones principales implementadas

### 4.1 Checkout e integridad de venta

- El checkout dejó de depender del guardado monolítico de catálogos completos.
- Venta, stock, caja, movimiento de caja y auditoría se confirman como una unidad transaccional.
- El éxito visual se muestra únicamente después de la confirmación de Firestore.
- El carrito permanece intacto cuando la operación no se confirma.
- Se agregó protección contra doble ejecución del cobro.
- Los errores de permisos, sesión, contención, stock, caja y conectividad se clasifican por separado.

### 4.2 Inventario y concurrencia

- Las modificaciones de stock usan el valor vivo leído dentro de una transacción.
- Se rechaza stock negativo.
- Se conserva el mecanismo de reintentos de Firestore ante concurrencia.
- Surtidos, traspasos y ajustes de caja evitan envíos dobles desde la interfaz.

### 4.3 Caja y ledger

- El documento principal de caja conserva solo estado operativo acotado.
- Los movimientos nuevos se guardan en `cashRegisters/{branchId}/transactions/{transactionId}`.
- El ledger es append-only y correlaciona ventas, aperturas, cierres, ingresos y egresos.
- El arreglo `transactions` legacy continúa siendo legible, pero no se sobrescribe ni elimina.
- Se preparó una migración idempotente y dry-run para copiar movimientos históricos; no se ejecutó.

### 4.4 Fechas, histórico y datos legacy

- Las ventas nuevas usan `createdAt` numérico como fecha canónica.
- Se agregó un parser controlado para fechas regionales históricas.
- Las fechas inválidas ya no se convierten silenciosamente en la fecha actual.
- Los listeners operativos de ventas y movimientos se limitaron al periodo necesario.
- Los periodos históricos se cargan bajo demanda.
- Se preparó una migración dry-run para ventas sin `branchId` o sin `createdAt`; no se ejecutó.

### 4.5 Almacenamiento local

- Las escrituras no críticas en `localStorage` se protegen frente a `QuotaExceededError` y otras excepciones.
- El checkout no depende de serializar el historial completo en almacenamiento local.
- Se eliminó la posibilidad de mostrar datos operativos legacy sin una sesión autenticada.

### 4.6 Web y Capacitor

- Se integró `@capacitor/network` como señal de transporte, no como prueba suficiente de que Firestore está listo.
- El cobro se bloquea mientras Firestore está comprobando o no puede confirmar acceso.
- La configuración de Capacitor fue preparada para empaquetar los assets locales.
- Se compiló previamente un APK debug como validación técnica, pero no se publicó ni se distribuyó durante esta sesión.

## 5. Reglas de Firestore desplegadas en sandbox

Las reglas nuevas se validaron primero con un dry-run y después se publicaron exclusivamente en `sandbox-pruebas`.

Cambios principales:

- denegación global por defecto conservada;
- membresía y roles por empresa conservados;
- nuevas ventas exigen `branchId`, `createdAt` numérico y estado válido;
- documento principal de caja protegido contra crecimiento y sobrescritura del historial legacy;
- cada cambio de saldo exige un movimiento correlacionado mediante `getAfter`;
- transacciones de caja inmutables, ligadas a sucursal y usuario creador;
- movimientos tipo `Venta` exigen una venta coincidente en sucursal y total;
- eventos de checkout son inmutables y el evento `success` exige la venta correspondiente.

Las reglas deben considerarse una base de seguridad sólida pero todavía revisable. Un cliente Firestore directo no puede imponer por sí solo todos los invariantes detallados de cada partida; para endurecimiento máximo, el checkout debería pasar en el futuro por una función o API confiable.

## 6. Índices desplegados en sandbox

Se desplegaron cuatro índices compuestos:

1. `sales`: `branchId ASC, createdAt DESC`.
2. `sales`: `branchId ASC, status ASC, createdAt DESC`.
3. `stockMovements`: `branchId ASC, createdAt DESC`.
4. `stockMovements`: `transferId ASC, type ASC`.

Inmediatamente después del despliegue, Firebase respondió temporalmente que los índices todavía se estaban construyendo. Se esperó y se repitió la verificación. En la comprobación final las consultas cargaron sin nuevos errores de índice.

## 7. Incidente de “35 problemas” y “Revisar acceso”

### 7.1 Síntoma observado

En `http://localhost:3000` aparecieron:

- alerta: `Ocurrieron 35 problemas al comunicarse con la nube`;
- indicador rojo: `Revisar acceso`;
- conexión a internet funcional.

### 7.2 Causa real

Los registros del navegador mostraron repetidamente:

```text
FIRESTORE INTERNAL ASSERTION FAILED: Unexpected state
ID: b815 / ca9
contador de respuestas: -1
```

No se encontró `permission-denied` ni una pérdida real de conectividad. El contador 35 representaba repeticiones del mismo fallo interno agrupadas por el manejador global de promesas.

La condición se producía porque el monitor de conectividad llamaba `enableNetwork(db)` mientras los listeners `onSnapshot` del POS se estaban registrando. Además, las notificaciones iniciales de red podían iniciar más de una comprobación simultánea. Esto generaba una carrera entre altas y bajas de targets dentro del stream de Firestore.

### 7.3 Actualización de Firebase

Se actualizó:

| Componente | Antes | Después |
|---|---:|---:|
| `firebase` | 12.13.0 | 12.18.0 |
| `@firebase/firestore` resuelto | 4.14.1 | 4.17.1 |

La actualización era necesaria, pero la prueba interactiva demostró que por sí sola no eliminaba el problema en este proyecto.

### 7.4 Corrección adicional en la aplicación

Se modificó el monitor de Firestore para:

- no llamar `enableNetwork()` durante el alta de listeners;
- confiar en la reconexión automática del SDK;
- impedir dos probes simultáneos mediante `probeInFlight`;
- consolidar señales de red duplicadas;
- esperar 750 ms antes del probe puntual para que los listeners principales terminen de registrarse;
- cancelar timers al desmontar o perder la red;
- mostrar un mensaje específico ante una aserción interna, en lugar de atribuirla falsamente a internet.

Después de reiniciar el servidor y recargar la aplicación no volvió a aparecer `b815/ca9`.

## 8. Operaciones ejecutadas

Las siguientes operaciones relevantes se realizaron durante la sesión:

```powershell
# Confirmación de bases y ediciones
npx -y firebase-tools@latest firestore:databases:list --project gen-lang-client-0749443687

# Actualización del SDK local
npm install firebase@12.18.0 --save

# Pruebas y compilación
npm test
npm run lint
npm run build

# Validación previa, sin desplegar
npx -y firebase-tools@latest deploy --only firestore:rules,firestore:indexes --dry-run --config firebase.sandbox.json --project gen-lang-client-0749443687

# Despliegue autorizado, solo sandbox
npx -y firebase-tools@latest deploy --only firestore:rules,firestore:indexes --config firebase.sandbox.json --project gen-lang-client-0749443687

# Comprobación de índices declarados
npx -y firebase-tools@latest firestore:indexes --database sandbox-pruebas --project gen-lang-client-0749443687
```

No se ejecutó el mismo comando con `firebase.json`, por lo que las reglas e índices de producción no se modificaron.

## 9. Validaciones y resultados

| Validación | Resultado |
|---|---|
| Pruebas unitarias | 5 aprobadas, 0 fallidas |
| TypeScript (`tsc --noEmit`) | Aprobado |
| Build Web/servidor | Aprobado; 1,961 módulos transformados |
| Reglas Firestore dry-run | Compilación correcta |
| Despliegue de reglas al sandbox | Correcto |
| Despliegue de índices al sandbox | Correcto |
| Inicio local | Correcto en `http://localhost:3000` |
| Aserción `b815/ca9` después del ajuste | No reapareció |
| Indicador `Revisar acceso` | Desapareció |
| Catálogo y caja | Cargaron correctamente |
| Producción | Sin cambios |

Vite mantiene una advertencia no bloqueante porque el bundle principal supera 500 kB. No impidió la compilación.

## 10. Archivos relevantes modificados o creados

- `src/App.tsx`: checkout, caja, consultas, red, manejo de errores y corrección de carrera de listeners.
- `src/firebase.ts`: selección local de base Firestore mediante variable de entorno.
- `src/lib/posSafety.ts`: helpers de fechas y clasificación de errores.
- `src/lib/posSafety.test.ts`: pruebas unitarias.
- `firestore.rules`: reglas para ventas, caja, ledger y auditoría.
- `firestore.indexes.json`: índices compuestos.
- `firebase.sandbox.json`: configuración de despliegue exclusiva del sandbox.
- `package.json` y `package-lock.json`: dependencias, scripts y Firebase 12.18.0.
- `capacitor.config.ts` y configuración Android: empaquetado local e integración de red.
- `scripts/migrate-legacy-sales.mjs`: migración segura de ventas legacy, no ejecutada.
- `scripts/migrate-cash-transactions.mjs`: migración segura del ledger, no ejecutada.
- `docs/REPARACION_VENTAS_CONCURRENCIA_IMPLEMENTADA.md`: documento técnico principal.
- `docs/FIRESTORE_RULES_AUDIT.json`: auditoría estructurada de reglas.

## 11. Estado actual y pendientes

### Completado

- Aplicación local conectada al sandbox.
- Firebase actualizado.
- Condición de carrera de listeners corregida.
- Reglas e índices publicados en `sandbox-pruebas`.
- Compilación y pruebas aprobadas.
- Servidor local encendido y verificado.

### Pendiente deliberadamente

- Prueba funcional de una venta completa y una apertura/cierre de caja con datos de prueba autorizados.
- Prueba simultánea con dos terminales reales.
- Ejecución dry-run de migraciones para una empresa específica.
- Revisión manual adicional de reglas antes de un lanzamiento amplio.
- Auditoría y reparación selectiva de dependencias.
- Commit y push al repositorio GitHub.
- Despliegue Web.
- Cualquier despliegue o migración en producción.
- Publicación de APK.

`npm install` reportó 24 vulnerabilidades en el árbol de dependencias: 2 bajas, 13 moderadas, 8 altas y 1 crítica. No se ejecutó `npm audit fix` ni `npm audit fix --force`, porque una reparación automática puede introducir actualizaciones incompatibles y queda fuera del alcance seguro de esta intervención.

## 12. Rollback

### Aplicación local

- Revertir la actualización de `firebase` en `package.json` y restaurar el `package-lock.json` correspondiente.
- Revertir únicamente el bloque del probe de conectividad en `src/App.tsx` si se identifica una regresión.
- Reiniciar el servidor local después de cualquier rollback.

### Reglas e índices del sandbox

- Recuperar la revisión anterior de `firestore.rules` y `firestore.indexes.json`.
- Validarla primero con `--dry-run` usando `firebase.sandbox.json`.
- Desplegarla exclusivamente a `sandbox-pruebas`.
- No borrar documentos del ledger ni ejecutar migraciones inversas masivas.

La base de producción no requiere rollback porque no recibió cambios durante esta sesión.

## 13. Estado de control de versiones

Al finalizar esta sesión, el árbol de trabajo contiene modificaciones y archivos nuevos sin confirmar. No existe todavía un commit que agrupe estos cambios y no se ha enviado contenido al remoto `tamalescastillo35-coder/logic_pos`.

Antes de crear commits se recomienda revisar el diff completo y separarlo al menos en:

1. integridad de checkout, caja y concurrencia;
2. fechas, datos legacy y migraciones;
3. consultas e índices;
4. red, Firebase y Capacitor;
5. reglas y auditoría;
6. pruebas y documentación.
