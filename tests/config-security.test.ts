import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeNetworkBinding } from '../src/config.js';

test('non-loopback MCP binding requires a bearer token', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost']) {
    assert.doesNotThrow(() => assertSafeNetworkBinding(host, null));
  }
  for (const host of ['0.0.0.0', '192.168.1.10', '::']) {
    assert.throws(() => assertSafeNetworkBinding(host, null), /MCP_AUTH_TOKEN/);
    assert.doesNotThrow(() => assertSafeNetworkBinding(host, 'strong-token'));
  }
});
