/**
 * Unit tests for device commands (Wave 3.4 F8).
 * No network. Uses injected fetch/read/write hooks. Run via: npm test
 */
import assert from 'node:assert/strict';
import {
  clearWorkerPreferredDevice,
  listWorkerDevices,
  preferWorkerDevice,
  runDeviceCommand
} from '../dist/device-cmd.js';

const preferredDeviceId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function baseConfig(overrides = {}) {
  return {
    device_id: '11111111-1111-4111-8111-111111111111',
    token: 't'.repeat(32),
    worker_url: 'https://deckagent.example.workers.dev',
    device_name: 'test-device',
    api_token: 'a'.repeat(32),
    heartbeat_interval: 15,
    tool_timeout: 60,
    auto_connect: true,
    log_level: 'info',
    ...overrides
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function testListWorkerDevices() {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    return jsonResponse({
      preferred_device_id: preferredDeviceId,
      devices: [
        {
          id: preferredDeviceId,
          name: 'Laptop',
          status: 'online',
          last_seen: 123
        }
      ]
    });
  };

  const result = await listWorkerDevices(baseConfig(), fetchImpl);
  assert.equal(result.preferred_device_id, preferredDeviceId);
  assert.equal(result.devices[0].name, 'Laptop');
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].input), 'https://deckagent.example.workers.dev/api/devices');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${'a'.repeat(32)}`);
}

async function testPreferWorkerDevice() {
  let seenBody = null;
  const fetchImpl = async (input, init) => {
    assert.equal(String(input), 'https://deckagent.example.workers.dev/api/devices/prefer');
    assert.equal(init.method, 'PUT');
    seenBody = JSON.parse(init.body);
    return jsonResponse({ ok: true, preferred_device_id: preferredDeviceId });
  };

  await preferWorkerDevice(baseConfig(), preferredDeviceId, fetchImpl);
  assert.deepEqual(seenBody, { device_id: preferredDeviceId });
  await assert.rejects(
    () => preferWorkerDevice(baseConfig(), 'not-a-uuid', fetchImpl),
    /Expected a UUID/
  );
}

async function testClearWorkerPreferredDevice() {
  const fetchImpl = async (input, init) => {
    assert.equal(String(input), 'https://deckagent.example.workers.dev/api/devices/prefer');
    assert.equal(init.method, 'DELETE');
    assert.equal(init.body, undefined);
    return jsonResponse({ ok: true, preferred_device_id: null });
  };

  await clearWorkerPreferredDevice(baseConfig({ preferred_device_id: preferredDeviceId }), fetchImpl);
}

async function testRunDeviceCommandWritesConfig() {
  const writes = [];
  const fetchImpl = async (_input, init) => {
    if (init.method === 'PUT') {
      return jsonResponse({ ok: true, preferred_device_id: preferredDeviceId });
    }
    if (init.method === 'DELETE') {
      return jsonResponse({ ok: true, preferred_device_id: null });
    }
    return jsonResponse({ preferred_device_id: null, devices: [] });
  };

  await runDeviceCommand(['prefer', preferredDeviceId], {
    readConfig: () => baseConfig(),
    writeConfig: (config) => writes.push(config),
    fetch: fetchImpl
  });
  assert.equal(writes[0].preferred_device_id, preferredDeviceId);

  await runDeviceCommand(['clear'], {
    readConfig: () => baseConfig({ preferred_device_id: preferredDeviceId }),
    writeConfig: (config) => writes.push(config),
    fetch: fetchImpl
  });
  assert.equal(writes[1].preferred_device_id, undefined);

  await runDeviceCommand(['list'], {
    readConfig: () => baseConfig(),
    writeConfig: (config) => writes.push(config),
    fetch: fetchImpl
  });
}

await testListWorkerDevices();
await testPreferWorkerDevice();
await testClearWorkerPreferredDevice();
await testRunDeviceCommandWritesConfig();
console.log('All device-cmd tests passed.');
