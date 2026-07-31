import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { assertSafeNetworkBinding } from '../src/config.js';

const exec = promisify(execFile);

async function readConfigWith(environment: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const script = "import('./src/config.ts').then(({config}) => console.log(JSON.stringify({mode:config.mode,sandbox:config.verificationSandbox,bypass:config.sandboxCiBypass,network:config.verificationNetwork})))";
  const result = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: environment
  });
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

test('non-loopback MCP binding requires a bearer token', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost']) {
    assert.doesNotThrow(() => assertSafeNetworkBinding(host, null));
  }
  for (const host of ['0.0.0.0', '192.168.1.10', '::']) {
    assert.throws(() => assertSafeNetworkBinding(host, null), /MCP_AUTH_TOKEN/);
    assert.doesNotThrow(() => assertSafeNetworkBinding(host, 'strong-token'));
  }
});

test('sandbox CI bypass cannot be enabled outside GitHub Actions', async () => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_MODE: 'workspace',
    MCP_VERIFICATION_SANDBOX: '1',
    MCP_SANDBOX_CI_BYPASS: '1',
    CI: 'true'
  };
  delete environment.GITHUB_ACTIONS;
  const result = await readConfigWith(environment);
  assert.equal(result.bypass, false);
  assert.equal(result.sandbox, true);
});

test('workspace refuses to start when verification sandbox is disabled', async () => {
  const script = "import('./src/config.ts').then(() => process.exit(2)).catch(error => { console.error(error.message); process.exit(0); })";
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_MODE: 'workspace',
    MCP_VERIFICATION_SANDBOX: '0'
  };
  delete environment.MCP_SANDBOX_CI_BYPASS;
  const result = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: environment
  });
  assert.match(result.stderr, /forbidden in workspace mode/);
});

test('verification network remains disabled outside full mode', async () => {
  const script = "import('./src/config.ts').then(() => process.exit(2)).catch(error => { console.error(error.message); process.exit(0); })";
  const result = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, MCP_MODE: 'workspace', MCP_VERIFICATION_NETWORK: '1' }
  });
  assert.match(result.stderr, /allowed only in full mode/);
});
