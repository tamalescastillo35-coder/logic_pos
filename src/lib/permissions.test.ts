import assert from 'node:assert/strict';
import test from 'node:test';
import { hasAppPermission } from './permissions.ts';

test('owners and administrators inherit every operational permission', () => {
  assert.equal(hasAppPermission('owner', [], 'products_edit'), true);
  assert.equal(hasAppPermission('master_admin', [], 'stock_transfer'), true);
  assert.equal(hasAppPermission('admin', [], 'cash_close'), true);
});

test('employees receive only explicitly assigned permissions', () => {
  assert.equal(hasAppPermission('employee', ['sales_history'], 'sales_history'), true);
  assert.equal(hasAppPermission('employee', ['sales_history'], 'products_edit'), false);
});
