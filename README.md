# LOGIC POS — Sistema de Punto de Venta Multi-Tenant

LOGIC POS es un sistema de punto de venta (POS) multi-tenant y white-label diseñado para optimizar las operaciones de venta, inventario y administración de comercios con múltiples sucursales. La aplicación funciona mediante una arquitectura híbrida: un frontend interactivo en React empaquetado opcionalmente con Capacitor para terminales y dispositivos móviles, un backend local minimalista basado en Express para el servicio de archivos estáticos y routing, y una integración nativa con los servicios de Google Firebase (Cloud Firestore y Firebase Auth) como base de datos en la nube en tiempo real.

---

## 🚀 Requisitos Previos

Antes de comenzar con la configuración e instalación del sistema, se requiere contar con las siguientes herramientas instaladas en el entorno local:

- **Node.js** (Versión 18.0.0 o superior recomendada)
- **npm** (Incluido por defecto en la instalación de Node.js)
- **Java Development Kit (JDK)** y **Android Studio** (Requerido únicamente si se desea compilar la aplicación móvil para Android)

---

## 🛠️ Instrucciones Paso a Paso para Correr el Proyecto

### 1. Clonar el repositorio e Instalar Dependencias
Abrir una terminal en el directorio del proyecto y ejecutar el siguiente comando para descargar e instalar todas las dependencias definidas en el archivo [package.json](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/package.json):

```bash
npm install
```

### 2. Levantar el Entorno de Desarrollo Local
Para iniciar el servidor de desarrollo, se debe ejecutar:

```bash
npm run dev
```

Este comando ejecuta el archivo [server.ts](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/server.ts) mediante `tsx`. El servidor Express se iniciará en el puerto `3000` (`http://localhost:3000`) y utilizará el middleware de desarrollo de Vite configurado en [vite.config.ts](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/vite.config.ts) para realizar recargas en caliente (Hot Module Replacement - HMR) del frontend en tiempo real.

### 3. Compilar para Producción (Entorno Web)
Si se desea preparar la aplicación para su despliegue en producción en la web (por ejemplo, en Firebase Hosting), se ejecuta:

```bash
npm run build
```

Este proceso realiza las siguientes tareas:
1. Compila los recursos estáticos del frontend (HTML, TypeScript, React y Tailwind CSS) y los deposita optimizados en la carpeta `dist`.
2. Utiliza `esbuild` para empaquetar el servidor de Node [server.ts](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/server.ts) en un único archivo de CommonJS localizado en `dist/server.cjs`.

Para arrancar el servidor compilado en producción, se ejecuta:

```bash
npm run start
```

### 4. Compilar y Sincronizar para Dispositivos Android (Capacitor)
Para generar el compilado móvil de Android y abrir el flujo de compilación nativo:

- **Sincronizar el frontend con la carpeta nativa de Android:**
  ```bash
  npm run cap:sync
  ```
  *(Compila el frontend y copia los archivos generados al proyecto de Android mediante Capacitor).*

- **Compilar directamente el APK en desarrollo:**
  ```bash
  npm run build:apk
  ```
  *(Compila el frontend, sincroniza el proyecto de Android y ejecuta las tareas de Gradle en la carpeta nativa para compilar un APK en modo Debug en `android/app/build/outputs/apk/debug/app-debug.apk`).*

---

## 📁 Estructura del Directorio del Proyecto

La arquitectura del proyecto está organizada de la siguiente manera:

- 📂 [android/](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/android): Proyecto nativo de Android configurado y gestionado por Capacitor.
- 📂 [docs/](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/docs): Bitácoras y checklists de control de calidad.
  - 📝 [CHECKLIST_PRUEBAS.md](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/docs/CHECKLIST_PRUEBAS.md): Protocolos de pruebas QA para validación de flujos.
  - 📝 [PROGRESO_DEV.md](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/docs/PROGRESO_DEV.md): Documento de seguimiento de tareas y desarrollo de funcionalidades.
- 📂 [src/](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/src): Carpeta contenedora del código fuente de la aplicación.
  - 📂 [components/](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/src/components): Componentes interactivos modulares de la interfaz gráfica.
  - ⚛️ [App.tsx](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/src/App.tsx): Componente principal y enrutador que contiene las pantallas del POS (Ventas, Inventario, Reportes, Panel de Configuración y Gestión de Personal).
  - 🔌 [firebase.ts](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/src/firebase.ts): Módulo de inicialización del SDK de Firebase y proveedores de autenticación.
  - 🎨 [index.css](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/src/index.css): Definición de estilos globales de la aplicación utilizando Tailwind CSS v4.
  - 🚀 [main.tsx](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/src/main.tsx): Punto de montaje inicial de la aplicación React.
- ⚙️ [server.ts](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/server.ts): Servidor backend con Express que sirve la aplicación web y gestiona el routing en producción y desarrollo.
- ⚙️ [capacitor.config.ts](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/capacitor.config.ts): Configuración global del puente móvil de Capacitor.
- ⚙️ [firebase.json](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/firebase.json): Configuración de servicios locales de Firebase y reglas de despliegue.
- 🛡️ [firestore.rules](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/firestore.rules): Reglas de seguridad basadas en roles y aislamiento multi-tenant para Cloud Firestore.
- 📝 [firebase-applet-config.json](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/firebase-applet-config.json): Archivo con las credenciales públicas de vinculación al proyecto de Google Firebase.

---

## 🗄️ Funcionamiento de la Base de Datos (Cloud Firestore)

La base de datos de LOGIC POS está diseñada bajo un modelo NoSQL y multi-tenant en Cloud Firestore. Toda la información se segmenta en base al identificador único de cada comercio (`companyId`), garantizando que los datos de diferentes empresas permanezcan aislados.

### Estructura de Colecciones y Rutas en Firestore

#### 1. Colección Raíz: `companies`
Contiene los documentos de cada comercio registrado.
Ruta: `/companies/{companyId}`

- **Subcolección `branches` (Sucursales):**
  Registra los puntos físicos de venta del comercio.
  Ruta: `/companies/{companyId}/branches/{branchId}`
  *Estructura del Documento:*
  ```json
  {
    "id": "B-001",
    "name": "Sucursal Centro",
    "address": "Av. Principal #123",
    "phone": "5551234567",
    "manager": "Nombre del Encargado",
    "isMatriz": false
  }
  ```

- **Subcolección `products` (Catálogo de Productos):**
  Almacena los artículos en venta y la existencia de inventario distribuido.
  Ruta: `/companies/{companyId}/products/{productId}`
  *Estructura del Documento:*
  ```json
  {
    "id": "P-10001",
    "name": "Producto de Ejemplo",
    "category": "Bebidas",
    "costPrice": 15.00,
    "salePrice": 25.00,
    "stock": 120,
    "minStock": 10,
    "sku": "SKU-10001",
    "branchStocks": {
      "B-001": 50,
      "B-002": 70
    }
  }
  ```

- **Subcolección `members` (Personal y Empleados):**
  Controla los accesos y los roles asignados a los usuarios del comercio.
  Ruta: `/companies/{companyId}/members/{memberUid}`
  *Estructura del Documento:*
  ```json
  {
    "userId": "auth_uid_generado_por_firebase",
    "name": "Juan Pérez",
    "email": "mi-codigo-de-comercio_101001@logicpos.com",
    "role": "employee", // "admin" para Encargados o "employee" para Cajeros
    "assignedBranchId": "B-001",
    "joinedAt": "2026-07-03T01:32:32Z",
    "customRoleName": "",
    "permissions": [],
    "isCredentialAccount": true
  }
  ```

---

## 🔌 Cómo Vincular un Proyecto de Firebase (Cuenta de Google)

Para conectar el sistema a su propio proyecto en la nube de Google Firebase, realice el siguiente procedimiento:

### Paso 1: Crear el Proyecto en la Consola de Firebase
1. Acceder a la [Consola de Firebase](https://console.firebase.google.com/) con una cuenta de Google.
2. Hacer clic en **Agregar proyecto** y asignarle un nombre (ej. `logic-pos-client`).
3. (Opcional) Deshabilitar Google Analytics para este proyecto de desarrollo o pruebas.

### Paso 2: Habilitar los Servicios Necesarios
1. **Cloud Firestore:**
   - En el menú lateral de la consola, ir a **Build > Firestore Database** y hacer clic en **Crear base de datos**.
   - Seleccionar la ubicación geográfica idónea para la base de datos y comenzar en **Modo de producción**.
2. **Firebase Authentication:**
   - Ir a **Build > Authentication** y hacer clic en **Comenzar**.
   - En la pestaña **Método de inicio de sesión**, habilitar los siguientes proveedores:
     - **Correo electrónico/contraseña** (asegurar activar la primera casilla para permitir inicio mediante contraseña convencional).
     - **Google** (permitiendo el acceso vía cuentas de Google para los Propietarios).

### Paso 3: Configurar el Archivo de Credenciales del Cliente
1. Dentro de la vista general del proyecto en Firebase, hacer clic en el ícono de **Web (</>)** para registrar una nueva aplicación.
2. Ingresar un nombre de registro para la app y hacer clic en **Registrar app**.
3. Copiar las variables de configuración de Firebase que se muestran en el bloque de código de inicialización.
4. En el directorio raíz de este proyecto, crear o modificar el archivo [firebase-applet-config.json](file:///C:/Users/josep/Desktop/EINNOVACION%20MX/swiftsale-pos/firebase-applet-config.json) con el siguiente formato:

```json
{
  "projectId": "TU_PROJECT_ID",
  "appId": "TU_APP_ID",
  "apiKey": "TU_API_KEY",
  "authDomain": "TU_PROJECT_ID.firebaseapp.com",
  "firestoreDatabaseId": "(default)",
  "storageBucket": "TU_PROJECT_ID.firebasestorage.app",
  "messagingSenderId": "TU_SENDER_ID",
  "measurementId": "TU_MEASUREMENT_ID"
}
```

> [!IMPORTANT]
> El campo `firestoreDatabaseId` por defecto debe tener el valor `"(default)"` a menos de que se esté empleando una base de datos con nombre personalizado en Firestore.

### Paso 4: Desplegar las Reglas de Seguridad de Firestore
Para aplicar las restricciones de seguridad que aíslan las empresas y regulan los accesos de los empleados:
1. Instalar la herramienta CLI de Firebase de forma global: `npm install -g firebase-tools`
2. Iniciar sesión con la cuenta de Google: `firebase login`
3. Seleccionar el proyecto activo: `firebase use TU_PROJECT_ID`
4. Desplegar las reglas con el comando: `firebase deploy --only firestore:rules`
