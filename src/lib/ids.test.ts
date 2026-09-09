import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocumentId, createInvitationCode } from './ids.ts';

test('document ids are unique and keep a rules-compatible shape', () => {
  const ids = new Set(Array.from({ length: 1_000 }, () => createDocumentId('C')));
  assert.equal(ids.size, 1_000);
  for (const id of ids) assert.match(id, /^C-[A-Za-z0-9-]+$/);
});
test('invitation codes use 80 random bits in a human-safe format', () => {
  const codes = new Set(Array.from({ length: 1_000 }, createInvitationCode));
  assert.equal(codes.size, 1_000);
  for (const code of codes) assert.match(code, /^INV-[A-F0-9]{20}$/);
});

