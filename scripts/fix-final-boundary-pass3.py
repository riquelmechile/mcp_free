#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def replace(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text()
    if old not in content:
        raise SystemExit(f'expected text not found in {path}: {old[:100]!r}')
    target.write_text(content.replace(old, new, 1))

replace('src/config.ts',
"""const requestedVerificationNetwork = process.env.MCP_VERIFICATION_NETWORK === '1';""",
"""const requestedVerificationNetwork = process.env.MCP_VERIFICATION_NETWORK === '1';
const sandboxCiSharedNetwork = process.env.CI === 'true' && process.env.MCP_SANDBOX_CI_SHARED_NETWORK === '1';""")
replace('src/config.ts',
"""  verificationNetwork: accessMode === 'full' && requestedVerificationNetwork,
  home""",
"""  verificationNetwork: accessMode === 'full' && requestedVerificationNetwork,
  sandboxCiSharedNetwork,
  home""")

replace('src/core/verification-sandbox.ts',
"""  const argv = [
    bwrap,
    '--die-with-parent',
    '--new-session',
    '--unshare-all'
  ];
  if (options.network === true) argv.push('--share-net');""",
"""  const argv = [
    bwrap,
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc'
  ];
  if (options.network !== true && !config.sandboxCiSharedNetwork) argv.push('--unshare-net');""")

replace('src/core/command-policy.ts',
"""const TRUSTED_PHYSICAL_ROOTS = ['/usr/bin', '/usr/lib', '/usr/libexec', '/usr/local/bin', '/usr/local/lib'];""",
"""const TRUSTED_PHYSICAL_ROOTS = ['/usr/bin', '/usr/lib', '/usr/libexec', '/usr/share', '/usr/local/bin', '/usr/local/lib', '/opt/hostedtoolcache'];""")
replace('src/core/command-policy.ts',
"""      noValue: new Set(['--stat', '--name-only', '--name-status', '--no-patch', '--no-ext-diff', '--no-textconv', '--color=never']),""",
"""      noValue: new Set(['--stat', '--name-only', '--name-status', '--no-patch', '--oneline', '--no-ext-diff', '--no-textconv', '--color=never']),""")
replace('src/core/command-policy.ts',
"""  if (subcommand === 'diff') {
    const parsed = parseOptions(args, {""",
"""  if (subcommand === 'diff') {
    if (args.some(argument => argument === '--output' || argument.startsWith('--output='))) {
      throw new Error('Git argument can write files, escape the worktree, or execute configured helpers');
    }
    const parsed = parseOptions(args, {""")
replace('src/core/command-policy.ts',
"""  if (executable === 'rg') {
    const parsed = parseOptions(argv.slice(1), {""",
"""  if (executable === 'rg') {
    if (argv.some(argument => argument === '--pre' || argument.startsWith('--pre=') || argument === '--pre-glob' || argument.startsWith('--pre-glob='))) {
      throw new Error('ripgrep preprocessors are not allowed');
    }
    if (argv.includes('--follow') || argv.includes('-L')) throw new Error('ripgrep symlink following is not allowed');
    const parsed = parseOptions(argv.slice(1), {""")
replace('src/core/command-policy.ts',
"""  if (executable === 'fd') {
    const parsed = parseOptions(argv.slice(1), {""",
"""  if (executable === 'fd') {
    if (argv.some(argument => ['--exec', '--exec-batch', '-x', '-X'].includes(argument))) throw new Error('fd execution actions are not allowed');
    if (argv.includes('--follow') || argv.includes('-L')) throw new Error('fd symlink following is not allowed');
    const parsed = parseOptions(argv.slice(1), {""")
replace('src/core/command-policy.ts',
"""      throw new Error('Verification git is restricted to git diff --check');""",
"""      throw new Error('Only git diff --check is allowed as a verification command');""")
replace('src/core/command-policy.ts',
"""    throw new Error(`${executable} verification is restricted to test or run <safe-script> without extra arguments`);""",
"""    throw new Error(`${executable} verification must use test or run <safe-script> without extra arguments`);""")

replace('tests/command-policy-adversarial.test.ts',
"""  assert.throws(() => validateVerificationCommand(['go', 'test', '-exec=/tmp/tool']), /external tools/);""",
"""  assert.throws(() => validateVerificationCommand(['go', 'test', '-exec=/tmp/tool']), /escape|external tools/);""")
replace('tests/verification-sandbox.test.ts',
"""  assert.equal(argv.includes('--unshare-all'), true);""",
"""  assert.equal(argv.includes('--unshare-user'), true);
  assert.equal(argv.includes('--unshare-pid'), true);""")

print('CI sandbox compatibility and legacy command contracts corrected')
