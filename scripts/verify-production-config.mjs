import fs from 'node:fs';

const EXPECTED_PROJECT_ID = 'gen-lang-client-0749443687';
const EXPECTED_DATABASE_ID = 'ai-studio-c55570ec-b91e-4564-addb-ad38305426a9';
const EXPECTED_LIVE_URL = 'https://tamalescastillo.com';

const readJson = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));
const failures = [];

const appConfig = readJson('firebase-applet-config.json');
const productionConfig = readJson('firebase.production.json');
const sandboxConfig = readJson('firebase.sandbox.json');
const capacitorConfig = fs.readFileSync('capacitor.config.ts', 'utf8');

if (appConfig.projectId !== EXPECTED_PROJECT_ID) {
  failures.push(`firebase-applet-config.json points to project ${appConfig.projectId || '(missing)'}`);
}
if (appConfig.firestoreDatabaseId !== EXPECTED_DATABASE_ID) {
  failures.push(`Production Web build points to database ${appConfig.firestoreDatabaseId || '(missing)'}`);
}
if (productionConfig.firestore?.database !== EXPECTED_DATABASE_ID) {
  failures.push(`firebase.production.json points to ${productionConfig.firestore?.database || '(missing)'}`);
}
if (sandboxConfig.firestore?.database !== 'sandbox-pruebas') {
  failures.push('firebase.sandbox.json no longer points to sandbox-pruebas');
}
if (!capacitorConfig.includes(`url: '${EXPECTED_LIVE_URL}'`)) {
  failures.push(`Capacitor no longer points to ${EXPECTED_LIVE_URL}`);
}
if (process.env.VITE_FIRESTORE_DATABASE_ID) {
  failures.push('VITE_FIRESTORE_DATABASE_ID must be unset for a production build');
}

if (failures.length > 0) {
  console.error('Production configuration check failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Production configuration verified: ${EXPECTED_PROJECT_ID}/${EXPECTED_DATABASE_ID}`);
