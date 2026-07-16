/**
 * Unit tests for applyKvNamespaceId (KV replace logic used by writeWorkerConfig).
 * No network. Run via: npm test
 */
import assert from 'node:assert/strict';
import { applyKvNamespaceId } from '../dist/deploy-worker.js';

function testReplaceEmptyId() {
  const input = `{
  "name": "deckagent",
  "kv_namespaces": [
    { "binding": "DECK_KV", "id": "" }
  ]
}`;
  const out = applyKvNamespaceId(input, 'abc123def456');
  assert.match(out, /"id": "abc123def456"/);
  assert.doesNotMatch(out, /"id": ""/);
}

function testReplaceExistingId() {
  const input = `{
  "kv_namespaces": [
    { "binding": "DECK_KV", "id": "a976361de2f94e5db7302cef849e87ab" }
  ]
}`;
  const out = applyKvNamespaceId(input, 'ffffffffffffffffffffffffffffffff');
  assert.match(out, /"id": "ffffffffffffffffffffffffffffffff"/);
  assert.doesNotMatch(out, /a976361de2f94e5db7302cef849e87ab/);
}

function testReplacePlaceholder() {
  const input = `{ "binding": "DECK_KV", "id": "YOUR_KV_NAMESPACE_ID" }`;
  const out = applyKvNamespaceId(input, '11112222333344445555666677778888');
  assert.equal(out, `{ "binding": "DECK_KV", "id": "11112222333344445555666677778888" }`);
}

function testIdBeforeBinding() {
  const input = `{ "id": "oldid", "binding": "DECK_KV" }`;
  const out = applyKvNamespaceId(input, 'newid999');
  assert.equal(out, `{ "id": "newid999", "binding": "DECK_KV" }`);
}

function testMultilineObject() {
  const input = `{
  "kv_namespaces": [
    {
      "binding": "DECK_KV",
      "id": "placeholder"
    }
  ]
}`;
  const out = applyKvNamespaceId(input, 'deadbeefcafebabe0000111122223333');
  assert.match(out, /"id": "deadbeefcafebabe0000111122223333"/);
  assert.doesNotMatch(out, /placeholder/);
}

function testMissingBindingThrows() {
  assert.throws(
    () => applyKvNamespaceId('{ "kv_namespaces": [] }', 'x'),
    /Could not find DECK_KV/
  );
}

testReplaceEmptyId();
testReplaceExistingId();
testReplacePlaceholder();
testIdBeforeBinding();
testMultilineObject();
testMissingBindingThrows();
console.log('All applyKvNamespaceId / writeWorkerConfig KV replace tests passed.');
