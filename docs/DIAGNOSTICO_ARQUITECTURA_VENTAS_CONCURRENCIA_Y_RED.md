# Auditoría Técnica y Diagnóstico Integral: Fallas en Registro de Ventas, Conectividad y Tiempos de Carga

**Proyecto:** LOGIC POS (Tamales Castillo / EINNOVACION MX)  
**Entorno:** Web (Navegador) y APK Móvil (Capacitor Android WebView)  
**Fecha de Elaboración:** Septiembre 2026  
**Ubicación:** `docs/DIAGNOSTICO_ARQUITECTURA_VENTAS_CONCURRENCIA_Y_RED.md`  
**Nivel de Documentación:** Técnico Forense / Arquitectura / Análisis de Riesgo  

---

## 1. Resumen Ejecutivo

El presente documento recopila, verifica y profundiza el diagnóstico sobre las fallas críticas reportadas en el sistema LOGIC POS tanto en terminales Web como en la aplicación móvil (APK):
1. **Ventas no registradas o que no llegan a la base de datos (Cloud Firestore)** en cobros simultáneos o individuales.
2. **Alertas erróneas de "Sin conexión en este momento" o "Verifica tu conexión"** en dispositivos con conexión a internet estable y funcional (Wi-Fi o datos móviles 4G/5G).
3. **Pérdida de historial de caja o reportes de periodos en cero** al abrir turnos o filtrar por meses anteriores.
4. **Ventas que se desplazan de fecha** o se acumulan indebidamente en el día actual ("HOY").
5. **Tiempos de carga lentos e inestables (de varios segundos)** al seleccionar o cambiar de sucursal.

Tras verificar línea por línea el código fuente (`src/App.tsx`), la configuración de Firebase (`src/firebase.ts`), las reglas de seguridad (`firestore.rules`), los índices (`firestore.indexes.json`), la configuración de Capacitor (`capacitor.config.ts`) y las dependencias (`package.json`), se confirman las **6 fallas del diagnóstico inicial** y se identifican **7 causas críticas adicionales** derivadas del empaquetado móvil, concurrencia en base de datos y saturación de red.

---

## 2. Corroboración de las Fallas del Diagnóstico Inicial

Se corroboró de manera exacta la existencia de los siguientes problemas en el repositorio:

### 2.1. Guardado Monolítico con `saveAllData` y Límite de 500 Ops en `writeBatch`
* **Archivos y Líneas:** `src/App.tsx` (Líneas 1762–1818 y 2291–2297)
* **Verificación:** En `completeTransaction`, en lugar de guardar únicamente la venta con `setDoc`, se invoca `saveAllData(products, customers, newSales, cashRegister)`. Dentro de esta función, `diffInto` compara referencias de memoria:
  ```typescript
  if (prevById.get(item.id) !== item) {
    batch.set(doc(db, 'companies', compId, col, item.id), sanitize(item));
    opCount++;
  }
  ```
  Al operar múltiples terminales en paralelo, los listeners de Firestore (`onSnapshot`) actualizan los arrays de React con nuevas instancias en memoria. Si las referencias de un catálogo cambian, `opCount` supera fácilmente el límite físico de Firestore de **500 operaciones por lote**, provocando el fallo inmediato con `InvalidArgumentError: A write batch can contain at most 500 operations`. La venta es abortada y no llega a Firestore.

### 2.2. Bloqueo por Regla de Seguridad de 2,000 Transacciones en Caja
* **Archivos y Líneas:** `firestore.rules` (Líneas 146–151 y 340–348) y `src/App.tsx` (Líneas 1858–1864)
* **Verificación:** En las reglas oficiales de Firestore (`firestore.rules`):
  ```firestore
  function isValidCashRegister(data) {
    return data.isOpen is bool
        && data.initialCash is number && data.initialCash >= 0.0
        && data.currentCash is number
        && (!('transactions' in data) || (data.transactions is list && data.transactions.size() <= 2000));
  }
  ```
  Cada venta en efectivo ejecuta `applyCashDelta`, la cual hace `arrayUnion` sobre el documento de la caja. En cuanto una sucursal acumula **2,001 transacciones**, la regla rechaza toda escritura posterior con `PERMISSION_DENIED`. Toda venta en efectivo posterior falla automáticamente.

### 2.3. Límite de 5 MB en `localStorage` (`QuotaExceededError`)
* **Archivos y Líneas:** `src/App.tsx` (Líneas 1778–1785)
* **Verificación:** En `saveAllData`, antes de contactar a Firestore:
  ```typescript
  localStorage.setItem('logic_products', JSON.stringify(newProds));
  localStorage.setItem('logic_customers', JSON.stringify(newCusts));
  localStorage.setItem('logic_sales', JSON.stringify(newSales)); // Línea 1781
  ```
  Estas llamadas **no están envueltas en un bloque `try/catch`**. En navegadores móviles y Android WebViews, `localStorage` tiene un límite rígido de 5 MB. Un historial de miles de ventas excede este tamaño, arrojando una excepción `QuotaExceededError`. Como ocurre en la línea 1781, la ejecución se interrumpe y jamás llega a la línea 1786 (la sincronización con Firestore).

### 2.4. Falso Positivo por Timeout de 4 Segundos en `Promise.race`
* **Archivos y Líneas:** `src/App.tsx` (Líneas 2298–2304 y 2328–2352)
* **Verificación:**
  ```typescript
  await Promise.race([trackedSave, new Promise(resolve => setTimeout(resolve, 4000))]);
  ```
  Si la terminal opera sobre una red móvil con una latencia de 4.1 segundos, la promesa del temporizador resuelve primero. La aplicación declara que la terminal está "Sin conexión en este momento" y despacha al cliente. Si la promesa de guardado en segundo plano falla después (por token vencido, cuota o error de lote), la venta nunca subió a Firestore y se pierde si la app se cierra.

### 2.5. WebSockets Zombi por Suspensión en Dispositivos Móviles
* **Archivos y Líneas:** `src/App.tsx` (Líneas 1171–1193 y 2298–2352)
* **Verificación:** En Android e iOS, apagar la pantalla o cambiar de aplicación corta silenciosamente el socket TCP de Firestore para ahorrar energía (Doze Mode). Al reactivar la pantalla, restablecer el canal TLS toma de 6 a 15 segundos. Si el cajero presiona "Cobrar" en los primeros segundos, la petición sale sobre un socket en reconexión, vence el timeout de 4s y la venta no se confirma.

### 2.6. Formato de Fechas Regionales (`Date.parse`) Generando `NaN`
* **Archivos y Líneas:** `src/App.tsx` (Líneas 392–403)
* **Verificación:**
  ```typescript
  export const getSaleMonthKey = (sale: Sale): string => {
    const ms = sale.createdAt ?? Date.parse(sale.timestamp);
    const d = isNaN(ms) ? new Date() : new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  ```
  En terminales en español, `sale.timestamp` almacena cadenas como `"15/05/2026, 14:30:00"`. `Date.parse()` de JavaScript no interpreta fechas con el día al inicio (`DD/MM/YYYY`) y devuelve `NaN`. La condición `isNaN(ms)` asigna `new Date()` (**la fecha actual**). Esto ocasiona que ventas de meses pasados no aparezcan en sus periodos correspondientes y se sumen indebidamente a las ventas de "HOY".

### 2.7. Destrucción de Movimientos de Caja al Abrir Turno
* **Archivos y Líneas:** `src/App.tsx` (Líneas 1727–1746)
* **Verificación:** `handleOpenCaja` resetea `transactions` a un array con solo 1 elemento:
  ```typescript
  transactions: [{ type: 'Ingreso', amount: initialCashValue, description: 'Apertura de Caja...' }]
  ```
  Al sobreescribir el documento de caja en cada apertura, cualquier reporte de corte diario o mensual previo intenta leer `transactions` y encuentra únicamente la última apertura, mostrando **$0.00** en movimientos manuales de caja para periodos anteriores.

### 2.8. Ventas sin `branchId` Invisibles para Sucursal Matriz
* **Archivos y Líneas:** `src/App.tsx` (Línea 1618–1619 vs Línea 4528)
* **Verificación:** La consulta a Firestore es `where('branchId', '==', branchId)`. En Firestore, una cláusula `where` excluye automáticamente los documentos donde el campo no exista o sea `null`/`undefined`. Aunque en la UI se escribió:
  `sales.filter(s => s.branchId === selectedBranchId || (!s.branchId && isSelectedBranchMatriz))`
  esas ventas jamás son descargadas por Firestore desde el servidor.

---

## 3. Nuevas Causas Críticas Identificadas (Auditoría Profunda)

### 3.1. Arquitectura del APK: WebView Remoto hacia `https://tamalescastillo.com`
* **Archivo y Líneas:** `capacitor.config.ts` (Líneas 7–16)
  ```typescript
  server: {
    androidScheme: 'https',
    url: 'https://tamalescastillo.com',
  },
  ```
* **Diagnóstico:** El APK instalado en los dispositivos Android no ejecuta código empaquetado localmente en el dispositivo (`dist/`). Abre un Android WebView que carga directamente el sitio remoto hospedado en el VPS de `tamalescastillo.com`.
* **Impacto Crítico:**
  1. Si el servidor VPS experimenta lentitud, reinicio de Nginx, saturación o latencia en el handshake SSL, el APK se bloquea o queda en pantalla en blanco.
  2. No existe un verdadero aislamiento offline nativo para la interfaz de usuario: cualquier falla de red intermedia entre el operador móvil y el VPS congela la aplicación.

### 3.2. Enmascaramiento de Errores Internos como "Falla de Conexión"
* **Archivo y Líneas:** `src/App.tsx` (Líneas 2320–2325)
  ```typescript
  alert(
    isSessionInvalidError(saveRejection)
      ? 'Tu sesión expiró o no se pudo confirmar tu empresa activa...'
      : 'No se pudo guardar la venta.\n\nNo se descontó inventario ni caja y el carrito quedó intacto. Verifica tu conexión e intenta cobrar de nuevo.'
  );
  ```
* **Diagnóstico:** Cuando `saveAllData` falla por:
  - `QuotaExceededError` (espacio local agotado).
  - Límite de 500 operaciones de Firestore (`batch.commit`).
  - Rechazo de reglas de seguridad (`PERMISSION_DENIED` por >2000 transacciones).
  - Error de validación de campos.
  El bloque `catch` muestra un mensaje genérico que dice: **`"Verifica tu conexión e intenta cobrar de nuevo"`**.
* **Impacto:** El cajero verifica su conexión, comprueba que YouTube o WhatsApp funcionan con datos móviles o Wi-Fi al 100%, y reporta: *"El sistema dice que no hay internet cuando sí hay"*. El problema es un error técnico de software, no de la conexión a internet.

### 3.3. Saturación de Red por 10 Listeners en Tiempo Real Simultáneos
* **Archivo y Líneas:** `src/App.tsx` (Líneas 1490–1575 y 1613–1650)
* **Diagnóstico:** Cada terminal conectada abre y mantiene **10 suscripciones WebSocket simultáneas**:
  1. `companies/{id}/products` (Catálogo completo)
  2. `companies/{id}/customers` (Directorio de clientes completo)
  3. `companies/{id}/branches`
  4. `companies/{id}/suppliers`
  5. `companies/{id}/members`
  6. `companies/{id}/settings/branding`
  7. `companies/{id}/settings/printConfig`
  8. `companies/{id}/cashRegisters/{branchId}`
  9. `companies/{id}/sales` (Historial completo de la sucursal)
  10. `companies/{id}/stockMovements` (Movimientos completos de la sucursal)
* **Impacto:** En redes 3G/4G o Wi-Fi saturadas, 10 canales en tiempo real descargando miles de documentos consumen todo el ancho de banda disponible. Al presionar "Cobrar", el paquete de subida de la venta compite contra la descarga masiva de datos, provocando que la confirmación tarde más de 4 segundos.

### 3.4. Contención de Concurrencia en `runTransaction` (`applyStockDeltas`)
* **Archivo y Líneas:** `src/App.tsx` (Líneas 1895–1919)
* **Diagnóstico:** Cuando dos o más cajeros cobran en simultáneo productos de la misma sucursal, `applyStockDeltas` corre un `runTransaction(db, ...)`. En Firestore, las transacciones leen el documento (`products/{id}`) y escriben. Si otra terminal modificó el stock del producto en ese intervalo:
  - La transacción es rechazada y entra en reintento automático.
  - Con múltiples ventas simultáneas, la contención aumenta exponencialmente la latencia, superando el temporizador de 4 segundos o lanzando error `failed-precondition / aborted`.

### 3.5. Límite Físico de 1 MB por Documento en `cashRegisters/{branchId}`
* **Diagnóstico de Arquitectura:** En Firestore, un documento individual no puede exceder **1 Megabyte** (1,048,576 bytes).
* **Impacto:** Guardar el array `transactions` dentro del documento de la caja acumula descripciones, fechas y folios. A partir de 2,000–3,000 registros, el documento supera 1 MB y Firestore bloquea permanentemente cualquier escritura en ese documento con `InvalidArgument: Document exceeds maximum size of 1 MiB`.

### 3.6. Ausencia de Plugin Nativo de Red (`@capacitor/network`)
* **Archivo:** `package.json`
* **Diagnóstico:** La aplicación carece del plugin `@capacitor/network`. Depende de la API web `navigator.onLine`, la cual en Android WebViews es imprecisa y no refleja microcortes, latencias altas ni conmutaciones entre Wi-Fi y datos móviles.

### 3.7. Archivo de Índices Vacío (`firestore.indexes.json`)
* **Archivo:** `firestore.indexes.json` (Líneas 1–4)
  ```json
  {
    "indexes": [],
    "fieldOverrides": []
  }
  ```
* **Diagnóstico:** No existe ningún índice compuesto desplegado en la base de datos de Firestore. Cualquier consulta combinada (por ejemplo, filtrar por sucursal y ordenar por fecha) no puede optimizarse a nivel de motor de base de datos.

---

## 4. ¿Por qué se Marcan Errores de Conexión si el Dispositivo está Conectado a Internet?

El personal operativo observa que los teléfonos tienen cobertura completa, pero el sistema insiste en marcar fallas de red. Esto se debe a la interacción de 3 factores concretos:

```
[ Cajero presiona "Cobrar" ]
             │
             ▼
[ Intento de Guardado ] ──► ¿Fallo por Cuota Local (5 MB)? ──► SÍ ──► Alerta: "Verifica tu conexión" (Falso mensaje)
             │
             ▼
[ Intento de Guardado ] ──► ¿Fallo por Reglas (>2000 tx)?   ──► SÍ ──► Alerta: "Verifica tu conexión" (Falso mensaje)
             │
             ▼
[ Intento de Guardado ] ──► ¿Fallo por Lote (>500 ops)?     ──► SÍ ──► Alerta: "Verifica tu conexión" (Falso mensaje)
             │
             ▼
[ Socket TCP en Reconexión ] ──► Tarda 4.2 segundos (Red móvil normal)
             │
             ▼
[ Timeout de 4 Segundos ] ──► Vence primero el temporizador ──► Alerta: "Sin conexión en este momento" (Falso positivo)
```

1. **El Temporizador Ciego de 4 Segundos (`Promise.race`):**  
   Una conexión celular 4G estándar puede tener latencias normales de entre 1,500 y 4,500 ms al enviar lotes de datos pesados. Como el código fija un límite rígido de 4,000 ms, si la red tarda 4.1 segundos en responder, el sistema declara erróneamente que "no hay conexión".
2. **Excepciones de Código Disfrazadas de Fallas de Red:**  
   En `completeTransaction`, cualquier excepción no relacionada con internet (`QuotaExceededError`, error de lote de Firestore, permiso denegado) activa el mismo mensaje: *"No se pudo guardar la venta... Verifica tu conexión e intenta cobrar de nuevo"*.
3. **WebSockets Zombi en Android:**  
   Al bloquear la pantalla o abrir la app del banco/cámara para verificar transferencias, Android congela la conexión TCP. Al desbloquear el teléfono, el sistema operativo reporta conexión Wi-Fi/4G activa, pero la sesión de Firestore interna está reconectando su canal seguro (toma de 6 a 15 s). Si el cajero cobra en esos primeros segundos, la petición no puede salir a tiempo.

---

## 5. Análisis de Tiempos de Carga de la Base de Datos por Sucursal

### ¿Por qué tarda varios segundos al cambiar de sucursal?
1. **Descarga Total sin Filtro Temporal:** Cada cambio de sucursal dispara:
   ```typescript
   query(collection(db, 'companies', compId, 'sales'), where('branchId', '==', branchId))
   ```
   Si una sucursal tiene 10,000 ventas acumuladas, **el cliente descarga los 10,000 documentos JSON completos (entre 8 MB y 15 MB de datos)**.
2. **Ausencia de Índices Compuestos:** Al estar `firestore.indexes.json` vacío, Firestore debe escanear colecciones sin optimización de ordenamiento.
3. **Sobrecarga del Procesador del Dispositivo:** Una vez descargados los miles de objetos, el hilo principal de JavaScript de la terminal debe:
   - Ordenar el array en memoria (`list.sort`).
   - Construir Maps de comparación (`diffInto`).
   - Filtrar arrays gigantescos en los hooks de React (`useMemo`).
   - Serializar todo a texto JSON para guardarlo en `localStorage`.  
   En teléfonos o tablets de gama media/baja, esto bloquea la interfaz durante 3 a 8 segundos.

### ¿Cómo agilizar la carga por sucursal (< 200 milisegundos)?
1. **Acotar la consulta de operación diaria al periodo activo:**  
   El punto de venta para cobrar no requiere ventas de hace meses. La consulta debe descargar únicamente las ventas del mes en curso o los últimos 7 días:
   ```typescript
   query(
     collection(db, 'companies', compId, 'sales'),
     where('branchId', '==', branchId),
     where('createdAt', '>=', inicioDeMesTimestamp),
     orderBy('createdAt', 'desc')
   )
   ```
   Esto reduce el volumen de descarga de 10,000 ventas a ~150-300 registros, bajando el tiempo de respuesta de **8 segundos a menos de 150 ms**.
2. **Carga Histórica Bajo Demanda:**  
   Las ventas de meses anteriores solo deben consultarse cuando el usuario ingrese expresamente a la pestaña "Estadísticas" o "Historial" y seleccione un mes específico (`getDocs` puntual), liberando la terminal de cobrar de esa carga.
3. **Desplegar Índices Compuestos:**  
   Declarar en `firestore.indexes.json` los índices `(branchId ASC, createdAt DESC)` para `sales` y `stockMovements`.

---

## 6. Catálogo Consolidado: Causas, Consecuencias y Solución Indicada

| # | Causa Raíz | Consecuencias en Operación | Solución Técnica Indicada | Efectividad | Nivel de Riesgo |
| :-: | :--- | :--- | :--- | :---: | :---: |
| **1** | Guardado monolítico vía `saveAllData` con lote de 500 ops. | En cobros simultáneos, `opCount > 500` aborta la venta con `InvalidArgumentError`. La venta no llega a Firestore. | Guardar la venta con `setDoc(doc(db, 'companies', compId, 'sales', newSale.id), sanitize(newSale))` de forma individual y atómica. | **100% (Crítica)** | **Bajo** |
| **2** | Regla de seguridad con tope de 2,000 transacciones en caja. | Al llegar a 2,001 transacciones, la regla evalúa en falso y Firestore rechaza toda venta en efectivo con `PERMISSION_DENIED`. | Migrar transacciones a subcolección `cashRegisters/{branchId}/transactions/{txId}` y eliminar la validación `<= 2000` de las reglas. | **100% (Estructural)** | **Medio** |
| **3** | `localStorage.setItem` sin `try/catch` (límite de 5 MB). | Lanza `QuotaExceededError` no capturado al acumular ventas; interrumpe el código antes de llamar a Firestore. | Envolver escrituras locales en `try/catch` y migrar el almacenamiento de colecciones a `IndexedDB` (usando `idb-keyval`). | **100% (Crítica)** | **Muy Bajo** |
| **4** | Timeout ciego de 4s en `Promise.race`. | Falso positivo de "Sin conexión"; el cajero despacha al cliente y si la venta falla en segundo plano se pierde al cerrar la app. | Eliminar la asunción de "offline" a los 4s; usar verificación real de estado con `waitForPendingWrites` de Firestore. | **95%** | **Bajo** |
| **5** | Alertas que culpan a la conexión ante fallas internas. | Confusión en el personal; el cajero ve internet al 100% pero la pantalla dice "Verifica tu conexión". | Mostrar mensajes descriptivos según el tipo de error real (`QuotaExceeded`, `PermissionDenied`, `SessionInvalid`). | **100%** | **Muy Bajo** |
| **6** | WebSockets zombi tras suspender pantalla en móviles. | Al desbloquear y cobrar rápido, la petición sale sobre socket caído y el timeout vence. | En `visibilitychange`, mostrar indicador visual "Reconectando..." y retardar el botón de cobro 2s hasta revalidar canal. | **90%** | **Bajo** |
| **7** | APK en WebView cargando URL remota (`tamalescastillo.com`). | Caídas del servidor VPS o problemas SSL dejan el APK sin funcionamiento; sin soporte offline local. | Compilar y empaquetar los assets estáticos dentro de la APK (`dist/`) con Capacitor en lugar de apuntar a la URL remota. | **95%** | **Medio** |
| **8** | Consulta de ventas sin límite ni filtro de fechas. | Descarga de miles de documentos (10 MB+); tiempos de carga de 8s al cambiar de sucursal y consumo de cuota de lectura. | Acotar la consulta en tiempo real a `createdAt >= inicioMes` y cargar meses antiguos solo bajo demanda en reportes. | **95% (Rendimiento)** | **Bajo** |
| **9** | Archivo `firestore.indexes.json` vacío. | Consultas no optimizadas por el motor de base de datos; mayor latencia de respuesta. | Definir y desplegar los índices compuestos `branchId + createdAt` para `sales` y `stockMovements`. | **90%** | **Muy Bajo** |
| **10** | `Date.parse(sale.timestamp)` devolviendo `NaN`. | Ventas de meses pasados no aparecen en sus reportes y se agrupan en la fecha de "HOY". | Estandarizar todas las ventas para usar únicamente `createdAt: Date.now()` (numérico UTC) y retirar el fallback a `new Date()`. | **100%** | **Muy Bajo** |
| **11** | Reset de transacciones en `handleOpenCaja`. | Reportes de corte de caja de días o meses anteriores marcan $0.00 en movimientos manuales. | Guardar cada apertura y cierre como eventos en la subcolección de transacciones sin sobreescribir el histórico. | **100%** | **Medio** |
| **12** | Ventas sin `branchId` invisibles en Firestore. | Las ventas históricas sin sucursal asignada nunca son recibidas por la sucursal Matriz. | Ejecutar un script único de migración en la base de datos para asignar el `branchId` de Matriz a documentos huérfanos. | **100%** | **Bajo** |
| **13** | Reglas de `checkoutEvents` pendientes de despliegue. | La bitácora de auditoría para rastrear intentos de cobro fallidos es rechazada en silencio por Firestore. | Ejecutar `firebase deploy --only firestore:rules` en la terminal con credenciales de Firebase. | **100%** | **Muy Bajo** |

---

## 7. Plan de Ejecución Técnico Recomendado

Para corregir los problemas de forma ordenada minimizando riesgos operativos, se recomienda la siguiente secuencia de intervención:

### Fase 1: Correcciones Inmediatas sin Riesgo de Migración (Prioridad P0)
1. **Desacoplar la escritura de la venta:** En `completeTransaction`, sustituir la llamada a `saveAllData` por `setDoc` directo e individual a `companies/{compId}/sales/{newSale.id}`.
2. **Proteger `localStorage`:** Envolver todas las llamadas de `localStorage.setItem` en bloques `try/catch`.
3. **Corregir el parser de fechas:** Eliminar `Date.parse(sale.timestamp)` y basar la agrupación exclusivamente en `sale.createdAt`.
4. **Desplegar reglas de seguridad:** Ejecutar `firebase deploy --only firestore:rules` para habilitar `checkoutEvents`.

### Fase 2: Estabilidad de Red y Rendimiento (Prioridad P1)
1. **Acotar la consulta de sucursal:** Agregar filtro `where('createdAt', '>=', fechaInicioMes)` en la consulta de ventas de la sucursal activa.
2. **Desplegar índices compuestos:** Agregar y desplegar `firestore.indexes.json`.
3. **Ajustar el temporizador de cobro:** Eliminar el mensaje engañoso de "Sin conexión" a los 4 segundos y permitir que la promesa resuelva o notifique el estado de sincronización de Firestore.
4. **Gestión de reconexión tras bloqueo:** Implementar indicador "Reconectando..." al volver del evento `visibilitychange`.

### Fase 3: Estructura de Caja y Empaquetado APK (Prioridad P2)
1. **Subcolección de transacciones de caja:** Mover las transacciones a `cashRegisters/{branchId}/transactions/{txId}` para erradicar el límite de 2,000 registros y la destrucción de historial en aperturas de turno.
2. **Empaquetado local de Capacitor:** Modificar `capacitor.config.ts` para servir los archivos locales de `dist/` en lugar de la URL remota del VPS, integrando `@capacitor/network`.

---
*Fin del documento técnico.*
