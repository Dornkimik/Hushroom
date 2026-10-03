import test from 'node:test';
import assert from 'node:assert/strict';
import { aliases, randomAlias } from '../lib/aliases.mjs';

test('guest aliases are single pronounceable words without awkward joins', () => {
  assert.ok(aliases.length > 800);
  assert.equal(new Set(aliases.map(a => a.toLowerCase())).size, aliases.length);
  for (const alias of aliases) {
    assert.match(alias, /^[A-Z][a-z]+$/);
    assert.ok(!/(.)\1\1/i.test(alias), alias);
  }
  assert.ok(!aliases.includes('Brookbrook'));
});

test('randomAlias avoids taken names and falls back to a numbered name', () => {
  const taken = new Set(aliases.slice(1));
  for (let i = 0; i < 20; i++) assert.ok([aliases[0], ...aliases.map(a => a + 2)].includes(randomAlias(a => taken.has(a))));
  assert.match(randomAlias(a => aliases.includes(a)), /^[A-Z][a-z]+2$/);
});
