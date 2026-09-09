# Auditoría y correcciones generales del proyecto

**Proyecto:** LOGIC POS / Tamales Castillo  
**Fecha:** 9 de septiembre de 2026 (America/Mexico_City)  
**Entorno local:** `http://localhost:3010`  
**Base local de pruebas:** `sandbox-pruebas`  
**Producción:** no modificada  
**GitHub, Web y APK:** sin commit, push ni despliegue  
**Reglas e índices:** publicados únicamente en `sandbox-pruebas`

## 1. Alcance

Esta revisión complementa la reparación de ventas, concurrencia y conectividad documentada el 8 de septiembre. Se auditó el proyecto completo con énfasis en:

- permisos funcionales y reglas de Firestore;
- integridad de inventario, traspasos, caja y auditoría;
- códigos de invitación y membresías;
- mensajes de error y falsas alertas de red;
- cargas del historial y límites de transacciones;
- rendimiento inicial;
- textos largos, modales, tarjetas y diseño responsive;
- dependencias de producción y compilación.

## 2. Correcciones implementadas

### Identificadores e invitaciones

- Los IDs nuevos usan `crypto.randomUUID()` en lugar de valores cortos basados en `Math.random()`.
- Los códigos de invitación usan 80 bits aleatorios, caducan en siete días y registran al creador.
- La rotación o revocación actualiza empresa e invitación en un mismo lote.
- Una invitación de uso único se consume atómicamente al entrar y deja de ser reutilizable.
- Las reglas rechazan campos extra en documentos de invitación.

### Permisos

Se definieron y aplicaron seis permisos explícitos:

1. consultar historial de ventas;
2. registrar o editar productos;
3. transferir inventario;
4. gestionar proveedores y surtidos;
5. cerrar caja;
6. aplicar descuentos.

Dueño y administradores conservan todos los permisos. Los empleados reciben únicamente los asignados. La interfaz oculta o bloquea acciones y las reglas vuelven a comprobar la autorización; por lo tanto, ocultar un botón no es la única defensa.

### Integridad de operaciones

- Una sucursal antigua guardada en el navegador ya no puede dejar al selector mostrando una sucursal distinta de la usada internamente. Si el ID dejó de existir, se selecciona y guarda automáticamente la primera sucursal válida.
- El estado de caja del módulo Historial ya no conserva el rótulo fijo “Caja activa” después del cierre; ahora distingue entre el flujo del día abierto y el último turno cerrado.
- Ajustes de stock y su movimiento de auditoría se confirman juntos.
- Traspasos actualizan ambos lados y sus movimientos en una sola operación atómica.
- Los guardados de producto, sucursal, proveedor y cliente esperan confirmación antes de cerrar el formulario.
- Las fallas conservan los datos del formulario o carrito para permitir reintento.
- Se mantienen las correcciones previas de checkout, caja, devoluciones y abonos atómicos.

### Conectividad y errores

- Se eliminó el manejador global que convertía cualquier promesa rechazada en “problema con la nube”.
- Los errores de permisos, sesión, reglas, conectividad y validación permanecen diferenciados.
- Los datos personales ya no se imprimen completos en los mensajes técnicos del navegador.
- Los plugins nativos de impresión conservan una sola instancia durante recargas rápidas de desarrollo y ya no generan nuevas advertencias de registro duplicado.
- No se implementaron ventas offline: Firestore puede mostrar información previamente almacenada, pero una venta solo se confirma cuando el servidor acepta toda la transacción. Esta decisión evita ventas duplicadas o inventario negativo al reconectar.

### Historial y rendimiento

- Los datos operativos en vivo conservan un máximo de 2,000 documentos por colección.
- Las consultas históricas solicitan 2,001 registros para detectar el límite, conservan los 2,000 más recientes y muestran una advertencia para acotar por mes o día.
- Los reportes de ingresos por sucursal y facturación mantienen una caché de diez minutos para evitar consultas repetidas.
- `jsPDF` y `jspdf-autotable` se cargan solamente al generar un PDF.
- El paquete inicial de producción bajó aproximadamente de 1.84 MB a 1.42 MB sin comprimir; los módulos PDF quedaron separados.

### Diseño responsive

- Se sustituyeron rejillas rígidas por variantes responsive en formularios y presentaciones vinculadas.
- Nombres, correos, direcciones, identificadores y líneas de tickets usan truncado o corte de palabra dentro de su contenedor.
- Tarjetas de clientes, sucursales, proveedores, recibos y facturas ya no fuerzan el ancho de pantalla.
- Se normalizaron utilidades visuales inválidas.
- La pantalla de acceso fue verificada a 390 × 844 y 1440 × 900 sin desbordamiento horizontal ni overlay de error.

## 3. Límites actuales

| Operación | Límite actual | Comportamiento al alcanzarlo |
|---|---:|---|
| Venta | 450 productos distintos | Se rechaza antes de guardar y se pide dividirla. |
| Traspaso | 150 productos distintos | Se rechaza y se pide crear dos traspasos; el límite reserva tres escrituras por producto. |
| Guardados masivos generales | Lotes de 400 escrituras | Se dividen automáticamente en lotes seguros. |
| Borrado masivo controlado | Lotes de 450 | Se divide automáticamente. |
| Flujo operativo en vivo | 2,000 documentos por colección | Se muestran los más recientes del periodo operativo. |
| Historial solicitado | 2,000 resultados por tipo | Si existe el 2,001, se avisa y debe elegirse un periodo menor. |
| Caché de reportes pesados | 10 minutos | Una reapertura inmediata reutiliza los resultados. |

Firestore admite como máximo 500 escrituras en un lote. Los topes de la aplicación dejan margen para documentos complementarios de venta, caja y auditoría.

## 4. Resultado de la auditoría de reglas

Las reglas mantienen denegación global por defecto, aislamiento por empresa, autoridad basada en membresías existentes, permisos por función, alcance por sucursal y registros críticos inmutables. No se identificó una ruta de elevación de rol ni de acceso entre empresas.

Riesgos residuales conocidos:

- Firestore Rules no puede validar profundamente cada objeto de un arreglo de hasta 450 partidas ni demostrar por sí solo que cada partida descontó exactamente el producto correspondiente. El checkout transaccional reduce el riesgo, pero el endurecimiento máximo requeriría una Cloud Function o API confiable.
- La colección `settings` es solo de administradores, pero sus documentos todavía no tienen un esquema y tamaño exhaustivos por tipo de configuración.
- Algunas colecciones legacy del usuario continúan disponibles únicamente para su propietario por compatibilidad.

La evaluación estructurada actual está en `docs/FIRESTORE_RULES_AUDIT.json` y obtiene **4/5**: segura para el modelo actual con riesgos menores conocidos, sin afirmar seguridad perfecta.

## 5. Dependencias

- Las dependencias usadas en producción no reportaron vulnerabilidades en la última consulta exitosa de `npm audit --omit=dev`.
- El análisis completo conserva ocho avisos moderados de herramientas de desarrollo, provenientes principalmente de dependencias transitivas de `firebase-admin`.
- No se aplicó `npm audit fix --force`, porque la solución propuesta introduce cambios incompatibles.
- Paquetes usados únicamente para compilar Web/Android se movieron a `devDependencies`.

## 6. Verificaciones realizadas

- 10 pruebas unitarias aprobadas.
- TypeScript sin errores.
- Build Web y servidor aprobado.
- Reglas e índices compilados correctamente mediante dry-run contra `sandbox-pruebas`.
- Reglas e índices publicados correctamente en `sandbox-pruebas`; los cuatro índices compuestos fueron consultados después del despliegue.
- Aplicación local iniciada en el puerto 3010 y enlazada por `.env.development.local` a `sandbox-pruebas`.
- Pantalla con contenido real, sin overlay Vite, sin errores o advertencias de consola y sin desbordamiento horizontal en móvil o escritorio.
- Revisión de utilidades responsive y textos largos completada.
- Prueba autenticada en `sandbox-pruebas`: apertura de caja con $500, venta en efectivo de un Mixiote por $60, caja actualizada a $560, stock actualizado de 21 a 20 e historial actualizado a una venta; sin errores de consola.
- Reembolso autenticado confirmado: la venta quedó marcada como reembolsada, el efectivo volvió de $560 a $500, el stock regresó de 20 a 21 y se conservaron los movimientos de venta y cancelación para auditoría.
- Cierre autenticado confirmado con $500 físicos y $500 esperados: caja cuadrada, encabezado en $0 para una caja cerrada y movimiento de cierre conservado.
- Recorrido autenticado de Terminal POS, Inventario, Clientes, Sucursales, Proveedores, Facturación, Historial/Caja, Estadísticas y Mi Empresa/Equipo: contenido cargado, sin falso aviso de conexión, sin “Revisar acceso” para el dueño y sin desbordamiento horizontal en escritorio.
- Se reprodujo y corrigió una sucursal obsoleta guardada como `b1`: la interfaz mostraba ÁGUILAS, pero las consultas internas usaban la sucursal inexistente y aparentaban stock cero. La aplicación ahora sustituye ese valor por una sucursal real.
- Se corrigió y verificó en vivo el rótulo del historial para que muestre “Caja cerrada (último turno)” después del cierre.
- Prueba concurrente autenticada en dos pestañas de Brave: ambas ventas sobre el mismo producto se confirmaron sin pérdida de actualización; el stock pasó de 21 a 19 y la caja de $500 a $620. El segundo checkout esperó el reintento transaccional y terminó correctamente.
- La caja de la prueba concurrente se cerró cuadrada con $620 esperados y $620 físicos. Las dos ventas permanecen intencionalmente como evidencia en `sandbox-pruebas`; el diálogo nativo de confirmación de Brave no permitió automatizar su reembolso con seguridad.

## 7. Despliegue de validación realizado

El 9 de septiembre de 2026 se publicaron `firestore.rules` y `firestore.indexes.json` utilizando exclusivamente `firebase.sandbox.json`. Firebase confirmó el destino `sandbox-pruebas`, compiló las reglas, liberó la revisión y registró correctamente los cuatro índices compuestos. Este comando no incluyó la base de producción.

## 8. Acciones no realizadas

- No se tocó la base de producción `ai-studio-c55570ec-b91e-4564-addb-ad38305426a9`.
- No se ejecutaron migraciones.
- No se creó commit ni se hizo push a GitHub.
- No se desplegó el sitio Web.
- No se generó ni publicó un APK nuevo.

## 9. Pendientes antes de producción

1. Probar con cuentas de empleado reales cada combinación de permisos en `sandbox-pruebas`.
2. Repetir el recorrido autenticado completo en un teléfono real o una sesión con emulación móvil; la pantalla de acceso sí fue comprobada a 390 × 844 y el código responsive fue auditado, pero el recorrido autenticado de esta sesión se hizo en Brave de escritorio.
3. Revisar el diff y separar los cambios en commits antes de enviarlos al repositorio.
4. Solo después de aprobar lo anterior, planear Web y reglas de producción con respaldo y ventana de reversión.
