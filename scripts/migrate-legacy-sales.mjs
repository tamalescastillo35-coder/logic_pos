#!/usr/bin/env node
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';

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
if (apply && databaseId === PRODUCTION_DATABASE && args.get('confirm-production') !== 'MIGRATE_LEGACY_SALES') {
  throw new Error('Producción requiere --confirm-production=MIGRATE_LEGACY_SALES además de --apply.');
}

const parseLegacyTimestamp = value => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}(?:T|\s)/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ')
    .replace(/a\.?\s*m\.?/g, 'am').replace(/p\.?\s*m\.?/g, 'pm');
  const match = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*(am|pm)?)?$/);
  if (!match) return null;
  const [, d, m, y, h = '0', min = '0', sec = '0', meridiem] = match;
  const day = Number(d); const month = Number(m); const year = Number(y);
  let hour = Number(h); const minute = Number(min); const second = Number(sec);
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  return date.getTime();
};

const app = initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore(app, databaseId);
const branchesSnapshot = await db.collection(`companies/${companyId}/branches`).get();
const configuredMatrixId = String(args.get('matrix-branch') || process.env.MATRIX_BRANCH_ID || '').trim();
const matrixBranches = branchesSnapshot.docs.filter(doc => doc.data().isMatriz === true);
const matrixBranchId = configuredMatrixId || (matrixBranches.length === 1 ? matrixBranches[0].id : '');
if (!matrixBranchId) {
  throw new Error(`No se pudo determinar Matriz: encontradas ${matrixBranches.length}. Usa --matrix-branch=<id>.`);
}

console.log(`${apply ? 'APPLY' : 'DRY-RUN'} legacy sales | project=${PROJECT_ID} database=${databaseId} company=${companyId} matriz=${matrixBranchId}`);
const sales = db.collection(`companies/${companyId}/sales`);
let cursor = null;
let scanned = 0;
let needsBranch = 0;
let needsCreatedAt = 0;
let invalidDate = 0;
let changed = 0;
let batch = db.batch();
let batchSize = 0;

while (true) {
  let pageQuery = sales.orderBy(FieldPath.documentId()).limit(500);
  if (cursor) pageQuery = pageQuery.startAfter(cursor);
  const page = await pageQuery.get();
  if (page.empty) break;

  for (const snapshot of page.docs) {
    scanned++;
    const data = snapshot.data();
    const update = {};
    if (typeof data.branchId !== 'string' || !data.branchId.trim()) {
      update.branchId = matrixBranchId;
      needsBranch++;
    }
    if (typeof data.createdAt !== 'number' || !Number.isFinite(data.createdAt)) {
      const parsed = parseLegacyTimestamp(data.timestamp);
      if (parsed === null) invalidDate++;
      else {
        update.createdAt = parsed;
        needsCreatedAt++;
      }
    }
    if (Object.keys(update).length === 0) continue;
    changed++;
    if (changed <= 20) console.log(`  ${snapshot.id}: ${JSON.stringify(update)}`);
    if (apply) {
      batch.update(snapshot.ref, update);
      batchSize++;
      if (batchSize === 400) {
        await batch.commit();
        batch = db.batch();
        batchSize = 0;
      }
    }
  }
  cursor = page.docs.at(-1);
}
if (apply && batchSize > 0) await batch.commit();

console.log(JSON.stringify({ scanned, wouldChange: changed, missingBranchId: needsBranch, parsedCreatedAt: needsCreatedAt, invalidLegacyDates: invalidDate, applied: apply }, null, 2));
if (!apply) console.log('Sin cambios. Repite con --apply solo después de revisar el conteo y las muestras.');
