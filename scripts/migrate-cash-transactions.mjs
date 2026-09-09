#!/usr/bin/env node
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'gen-lang-client-0749443687';
const PRODUCTION_DATABASE = 'ai-studio-c55570ec-b91e-4564-addb-ad38305426a9';
const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : true];
}));
const companyId = String(args.get('company') || process.env.COMPANY_ID || '').trim();
const databaseId = String(args.get('database') || process.env.FIRESTORE_DATABASE_ID || 'sandbox-pruebas').trim();
const apply = args.has('apply');
if (!companyId) throw new Error('Falta --company=<companyId>.');
if (apply && databaseId === PRODUCTION_DATABASE && args.get('confirm-production') !== 'MIGRATE_CASH_LEDGER') {
  throw new Error('Producción requiere --confirm-production=MIGRATE_CASH_LEDGER además de --apply.');
}

const app = initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore(app, databaseId);
const registers = await db.collection(`companies/${companyId}/cashRegisters`).get();
console.log(`${apply ? 'APPLY' : 'DRY-RUN'} cash ledger | project=${PROJECT_ID} database=${databaseId} company=${companyId}`);

let legacyEntries = 0;
let migratable = 0;
let missingCreatedAt = 0;
let alreadyPresent = 0;
let batch = db.batch();
let batchSize = 0;

for (const register of registers.docs) {
  const entries = Array.isArray(register.data().transactions) ? register.data().transactions : [];
  legacyEntries += entries.length;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)) {
      missingCreatedAt++;
      continue;
    }
    const id = `LEGACY-${entry.createdAt}-${index}`;
    const target = register.ref.collection('transactions').doc(id);
    if ((await target.get()).exists) {
      alreadyPresent++;
      continue;
    }
    const cashDelta = entry.type === 'Egreso' ? -Math.abs(Number(entry.amount) || 0)
      : entry.type === 'Transferencia' ? 0 : Math.abs(Number(entry.amount) || 0);
    const migrated = {
      id,
      type: String(entry.type || 'Ingreso'),
      amount: Math.abs(Number(entry.amount) || 0),
      cashDelta,
      description: String(entry.description || 'Movimiento legacy').slice(0, 1000),
      time: String(entry.time || '').slice(0, 100),
      timestamp: new Date(entry.createdAt).toISOString(),
      createdAt: entry.createdAt,
      branchId: register.id,
      createdBy: 'legacy-migration',
      ...(entry.shiftId ? { shiftId: String(entry.shiftId).slice(0, 128) } : {}),
    };
    migratable++;
    if (migratable <= 20) console.log(`  ${register.id}/${id}: ${migrated.type} ${migrated.amount}`);
    if (apply) {
      batch.create(target, migrated);
      batchSize++;
      if (batchSize === 400) {
        await batch.commit();
        batch = db.batch();
        batchSize = 0;
      }
    }
  }
}
if (apply && batchSize > 0) await batch.commit();

console.log(JSON.stringify({ registers: registers.size, legacyEntries, wouldCreate: migratable, alreadyPresent, skippedWithoutCreatedAt: missingCreatedAt, applied: apply }, null, 2));
console.log('El array legacy NO se elimina. Esta migración solo copia eventos a la subcolección y es idempotente.');
