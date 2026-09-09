// Analiza companies/{companyId}/checkoutEvents — la bitacora invisible de intentos de cobro
// agregada en "Agregar registro invisible de intentos de cobro (checkoutEvents)" — para
// responder: de los intentos de cobro reales, cuantos terminaron en venta guardada y cuantos
// se perdieron (y por que: falla tecnica vs. cola offline nunca resuelta vs. se quedo a medias).
//
// Solo lectura. No modifica nada.
//
// Uso (PowerShell, desde la raiz del proyecto):
//   $env:ANALYSIS_COMPANY_ID = '<codigo de comercio>'
//   $env:ANALYSIS_EMPLOYEE_NUM = '<numero de un empleado credential existente (cualquier rol)>'
//   node scripts/analyze-checkout-events.mjs
//
// Requiere un empleado credential ya existente en esa empresa (mismo requisito que
// load-tamales-castillo.mjs) — checkoutEvents solo se puede leer estando autenticado como
// miembro de la empresa (regla de Firestore).
//
// Opcional: $env:ANALYSIS_SINCE_DAYS = '30' (default 90) limita la ventana de tiempo analizada.

import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, collection, query, where, getDocs } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'firebase-applet-config.json'), 'utf8'));

const COMPANY_ID = (process.env.ANALYSIS_COMPANY_ID || '').trim();
const EMPLOYEE_NUM = (process.env.ANALYSIS_EMPLOYEE_NUM || '').trim();
const SINCE_DAYS = Number(process.env.ANALYSIS_SINCE_DAYS || '90');

if (!COMPANY_ID || !EMPLOYEE_NUM) {
  console.error('Faltan variables de entorno. Corre primero:');
  console.error("  $env:ANALYSIS_COMPANY_ID = '<codigo de comercio>'");
  console.error("  $env:ANALYSIS_EMPLOYEE_NUM = '<numero de empleado credential existente>'");
  process.exit(1);
}

const app = initializeApp(cfg);
const auth = getAuth(app);
const db = getFirestore(app, cfg.firestoreDatabaseId);

const email = `${COMPANY_ID.toLowerCase()}_${EMPLOYEE_NUM}@logicpos.com`;

// Terminal outcomes only — 'started' and the unresolved half of 'offline_queued' are transient
// states, folded into the buckets below by inspecting every event for the same saleId together.
const OUTCOME = {
  success: 'success',
  offlineResolvedSuccess: 'offline_resolved_success',
  failed: 'failed',
  offlineResolvedFailed: 'offline_resolved_failed',
};

function classify(eventsForSale) {
  const statuses = new Set(eventsForSale.map(e => e.status));
  if (statuses.has(OUTCOME.success) || statuses.has(OUTCOME.offlineResolvedSuccess)) return 'success';
  if (statuses.has(OUTCOME.failed) || statuses.has(OUTCOME.offlineResolvedFailed)) return 'failed';
  if (statuses.has('offline_queued')) return 'offline_unresolved'; // sigue en cola o el dispositivo nunca volvio a resolver
  if (statuses.has('started')) return 'stuck'; // arranco y no volvio a escribir nada (app cerrada/crash a medio cobro)
  return 'unknown';
}

async function main() {
  console.log(`\n== Analisis de checkoutEvents -> empresa "${COMPANY_ID}" (ultimos ${SINCE_DAYS} dias) ==\n`);
  console.log(`Iniciando sesion como ${email}...`);
  await signInWithEmailAndPassword(auth, email, EMPLOYEE_NUM);
  console.log('Sesion iniciada.\n');

  const sinceMs = Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000;
  const evSnap = await getDocs(query(
    collection(db, 'companies', COMPANY_ID, 'checkoutEvents'),
    where('createdAt', '>=', sinceMs)
  ));

  if (evSnap.empty) {
    console.log('No hay eventos en checkoutEvents todavia.');
    console.log('Esto es esperado si las reglas de Firestore (firestore.rules) para esta coleccion');
    console.log('aun no se han publicado con: firebase deploy --only firestore:rules');
    console.log('Hasta que eso pase, cada intento de cobro se escribe pero Firestore lo rechaza en silencio.');
    return;
  }

  const bySale = new Map();
  for (const d of evSnap.docs) {
    const e = d.data();
    if (!bySale.has(e.saleId)) bySale.set(e.saleId, []);
    bySale.get(e.saleId).push(e);
  }

  const counts = { success: 0, failed: 0, offline_unresolved: 0, stuck: 0, unknown: 0 };
  const failedDetails = [];
  const byBranch = new Map(); // branchName -> { success, failed, offline_unresolved, stuck }
  const byEmployee = new Map();

  for (const [saleId, events] of bySale) {
    const outcome = classify(events);
    counts[outcome]++;

    const last = events[events.length - 1];
    const branch = last.branchName || last.branchId || 'Sin sucursal';
    const employee = last.employeeName || 'Sin nombre';

    for (const [mapObj, key] of [[byBranch, branch], [byEmployee, employee]]) {
      if (!mapObj.has(key)) mapObj.set(key, { success: 0, failed: 0, offline_unresolved: 0, stuck: 0, unknown: 0 });
      mapObj.get(key)[outcome]++;
    }

    if (outcome === 'failed') {
      const failEvent = events.find(e => e.status === 'failed' || e.status === 'offline_resolved_failed');
      failedDetails.push({
        saleId,
        branch,
        employee,
        total: last.total,
        error: failEvent?.errorMessage || '(sin mensaje)',
        sessionInvalid: !!failEvent?.isSessionInvalid,
      });
    }
  }

  const totalAttempts = bySale.size;
  const pct = n => totalAttempts ? ((n / totalAttempts) * 100).toFixed(1) : '0.0';

  console.log(`Intentos de cobro registrados: ${totalAttempts}\n`);
  console.log('— Resultado —');
  console.log(`  Exitosas:              ${counts.success} (${pct(counts.success)}%)`);
  console.log(`  Fallidas:               ${counts.failed} (${pct(counts.failed)}%)`);
  console.log(`  Offline sin resolver:   ${counts.offline_unresolved} (${pct(counts.offline_unresolved)}%)`);
  console.log(`  A medias (sin cierre):  ${counts.stuck} (${pct(counts.stuck)}%)`);
  if (counts.unknown) console.log(`  Sin clasificar:         ${counts.unknown} (${pct(counts.unknown)}%)`);

  console.log('\n— Por sucursal —');
  for (const [branch, c] of [...byBranch.entries()].sort((a, b) => b[1].failed - a[1].failed)) {
    const total = c.success + c.failed + c.offline_unresolved + c.stuck + c.unknown;
    console.log(`  ${branch.padEnd(20)} total ${String(total).padStart(4)} · ok ${c.success} · fallidas ${c.failed} · offline sin resolver ${c.offline_unresolved} · a medias ${c.stuck}`);
  }

  console.log('\n— Por empleado (top 10 por fallas) —');
  for (const [employee, c] of [...byEmployee.entries()].sort((a, b) => b[1].failed - a[1].failed).slice(0, 10)) {
    const total = c.success + c.failed + c.offline_unresolved + c.stuck + c.unknown;
    console.log(`  ${employee.padEnd(20)} total ${String(total).padStart(4)} · ok ${c.success} · fallidas ${c.failed} · offline sin resolver ${c.offline_unresolved} · a medias ${c.stuck}`);
  }

  if (failedDetails.length) {
    console.log('\n— Detalle de ventas fallidas —');
    for (const f of failedDetails) {
      console.log(`  ${f.saleId} · ${f.branch} · ${f.employee} · $${f.total ?? '?'} · ${f.sessionInvalid ? '[sesion invalida] ' : ''}${f.error}`);
    }
  }

  console.log('\n== Fin del analisis ==\n');
}

main().catch(err => {
  console.error('\nERROR:', err.code || '', err.message || err);
  process.exit(1);
});
