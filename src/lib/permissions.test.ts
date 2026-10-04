import assert from 'node:assert/strict';
import test from 'node:test';
import { getDefaultPermissions, hasAppPermission } from './permissions.ts';

test('owners inherit every operational permission and administrators their role defaults', () => {
  assert.equal(hasAppPermission('owner', [], 'products_edit'), true);
  for (const permission of getDefaultPermissions('admin')) {
    assert.equal(hasAppPermission('admin', [], permission), true, permission);
  }
  assert.equal(hasAppPermission('admin', [], 'products_edit'), false);
});

test('employees receive only explicitly assigned permissions', () => {
  assert.equal(hasAppPermission('employee', ['sales_history'], 'sales_history'), true);
  assert.equal(hasAppPermission('employee', ['sales_history'], 'products_edit'), false);
});
