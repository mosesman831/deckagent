import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deleteDevice,
  getDevice,
  getSessionByToken,
  getTokenRecord,
  putDevice,
  updateDeviceCapabilities,
  updateDeviceStatus,
} from '../src/device-registry.js';
import { fakeEnv } from './helpers.js';

function sampleDevice() {
  return {
    device_id: 'dev-1',
    name: 'My MacBook',
    status: 'offline',
    ip: '',
    last_seen: 0,
    capabilities: ['filesystem', 'terminal'],
    token: 'device-token-abc',
  };
}

test('putDevice / getDevice round-trips a device', async () => {
  const env = fakeEnv();
  await putDevice(env, sampleDevice());
  const got = await getDevice(env, 'dev-1');
  assert.ok(got);
  assert.equal(got.name, 'My MacBook');
  assert.deepEqual(got.capabilities, ['filesystem', 'terminal']);
});

test('getDevice returns null for an unknown device', async () => {
  const env = fakeEnv();
  assert.equal(await getDevice(env, 'nope'), null);
});

test('updateDeviceStatus marks online and bumps last_seen', async () => {
  const env = fakeEnv();
  await putDevice(env, sampleDevice());
  const before = Date.now();
  const updated = await updateDeviceStatus(env, 'dev-1', 'online');
  assert.ok(updated);
  assert.equal(updated.status, 'online');
  assert.ok(updated.last_seen >= before);
  const reread = await getDevice(env, 'dev-1');
  assert.equal(reread?.status, 'online');
});

test('updateDeviceStatus returns null for an unknown device', async () => {
  const env = fakeEnv();
  assert.equal(await updateDeviceStatus(env, 'nope', 'online'), null);
});

test('updateDeviceCapabilities replaces the capability list', async () => {
  const env = fakeEnv();
  await putDevice(env, sampleDevice());
  const updated = await updateDeviceCapabilities(env, 'dev-1', ['browser']);
  assert.deepEqual(updated?.capabilities, ['browser']);
});

test('deleteDevice removes the device', async () => {
  const env = fakeEnv();
  await putDevice(env, sampleDevice());
  await deleteDevice(env, 'dev-1');
  assert.equal(await getDevice(env, 'dev-1'), null);
});

test('getTokenRecord / getSessionByToken resolve a session via a token', async () => {
  const env = fakeEnv();
  const token = 'access-token-xyz';
  await env.DECK_KV.put(
    `token:${token}`,
    JSON.stringify({ user_id: '42', github_username: 'octocat', created_at: 1 }),
  );
  await env.DECK_KV.put(
    'session:42',
    JSON.stringify({
      access_token: token,
      github_username: 'octocat',
      avatar_url: 'https://avatars/x',
      device_id: 'dev-1',
      created_at: 1,
    }),
  );

  const record = await getTokenRecord(env, token);
  assert.equal(record?.user_id, '42');

  const session = await getSessionByToken(env, token);
  assert.ok(session);
  assert.equal(session.github_username, 'octocat');
  assert.equal(session.device_id, 'dev-1');
});

test('getSessionByToken returns null for an unknown token', async () => {
  const env = fakeEnv();
  assert.equal(await getSessionByToken(env, 'unknown'), null);
});
