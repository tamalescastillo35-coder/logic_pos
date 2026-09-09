import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CashRegisterClosedError,
  StockUnavailableError,
  describeCheckoutError,
  getRecordDayKey,
  getRecordMonthKey,
  parseLegacyLocalizedTimestamp,
  resolveActiveBranchId,
} from './posSafety.ts';

test('parses DD/MM/YYYY 24-hour legacy timestamps without moving the sale to today', () => {
  const millis = parseLegacyLocalizedTimestamp('15/05/2026, 14:30:00');
  assert.notEqual(millis, null);
  assert.equal(getRecordMonthKey({ timestamp: '15/05/2026, 14:30:00' }), '2026-05');
  assert.equal(getRecordDayKey({ timestamp: '15/05/2026, 14:30:00' }), '2026-05-15');
});

test('parses es-MX a.m./p.m. variants', () => {
  const millis = parseLegacyLocalizedTimestamp('30/6/2026, 4:55 p.m.');
  assert.notEqual(millis, null);
  const parsed = new Date(millis!);
  assert.equal(parsed.getHours(), 16);
  assert.equal(getRecordMonthKey({ timestamp: '30/6/2026, 4:55 p.m.' }), '2026-06');
});

test('invalid historical dates return an empty bucket instead of the current date', () => {
  assert.equal(parseLegacyLocalizedTimestamp('31/02/2025, 10:00:00'), null);
  assert.equal(getRecordMonthKey({ timestamp: 'fecha desconocida' }), '');
  assert.equal(getRecordDayKey({ timestamp: 'fecha desconocida' }), '');
});

test('numeric createdAt is canonical even when the display timestamp is invalid', () => {
  const createdAt = new Date(2024, 10, 9, 12, 0, 0).getTime();
  assert.equal(getRecordDayKey({ createdAt, timestamp: 'invalid' }), '2024-11-09');
});

test('replaces a stale saved branch with a real branch instead of trusting the select fallback', () => {
  assert.equal(resolveActiveBranchId('b1', ['B-AGUILAS', 'B-MATRIZ']), 'B-AGUILAS');
  assert.equal(resolveActiveBranchId('B-MATRIZ', ['B-AGUILAS', 'B-MATRIZ']), 'B-MATRIZ');
  assert.equal(resolveActiveBranchId('b1', []), '');
});

test('checkout errors distinguish permissions, contention, connectivity, stock, and register state', () => {
  assert.equal(describeCheckoutError({ code: 'permission-denied' }).kind, 'permission');
  assert.equal(describeCheckoutError({ code: 'firestore/aborted' }).kind, 'contention');
  assert.equal(describeCheckoutError({ code: 'unavailable' }).kind, 'offline');
  assert.equal(describeCheckoutError(new StockUnavailableError('sin stock')).kind, 'stock');
  assert.equal(describeCheckoutError(new CashRegisterClosedError()).kind, 'register-closed');
});
