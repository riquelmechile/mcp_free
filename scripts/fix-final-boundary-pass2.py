#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def replace(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text()
    if old not in content:
        raise SystemExit(f'expected text not found in {path}: {old[:100]!r}')
    target.write_text(content.replace(old, new, 1))

replace('src/core/development.ts',
"""  const [branch, head, status, diffStat] = await Promise.all(canonical.map(command => runInspectionCommand(root, command, { timeoutMs: 15_000 })));
  return {
    root,
    branch: branch.stdout.trim() || '(detached)',
    head: head.exitCode === 0 ? head.stdout.trim() : null,
    status: status.stdout.trim(),
    diffStat: diffStat.stdout.trim()
  };""",
"""  const results = await Promise.all(canonical.map(command => runInspectionCommand(root, command, { timeoutMs: 15_000 })));
  const branch = results[0];
  const head = results[1];
  const status = results[2];
  const diffStat = results[3];
  if (!branch || !head || !status || !diffStat) throw new Error('Incomplete Git snapshot results');
  return {
    root,
    branch: branch.stdout.trim() || '(detached)',
    head: head.exitCode === 0 ? head.stdout.trim() : null,
    status: status.stdout.trim(),
    diffStat: diffStat.stdout.trim()
  };""")

replace('src/core/development.ts',
"""const INSPECTION_ENV: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  NO_COLOR: '1'
};""",
"""const INSPECTION_ENV: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  NO_COLOR: '1'
};
const SENSITIVE_ARG = /(^|\\/)(\\.env(?:\\.|$)|\\.ssh|\\.gnupg|secrets?|credentials?)(\\/|$)|\\.(?:pem|key)$/i;""")

old = """    return runCommand(command, {
      cwd: realRoot,
      timeoutMs: options.timeoutMs,
      maxTimeoutMs: options.maxTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      signal: options.signal,
      stdin: options.stdin,
      inheritEnv: false,
      env: HOST_ENVIRONMENT
    });"""
new = """    return runCommand(command, {
      cwd: realRoot,
      timeoutMs: options.timeoutMs,
      ...(options.maxTimeoutMs !== undefined ? { maxTimeoutMs: options.maxTimeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      inheritEnv: false,
      env: HOST_ENVIRONMENT
    });"""
replace('src/core/verification-sandbox.ts', old, new)

old2 = """  const result = await runCommand(sandboxArgv, {
    cwd: realRoot,
    timeoutMs: options.timeoutMs,
    maxTimeoutMs: options.maxTimeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    signal: options.signal,
    stdin: options.stdin,
    inheritEnv: false,
    env: HOST_ENVIRONMENT
  });"""
new2 = """  const result = await runCommand(sandboxArgv, {
    cwd: realRoot,
    timeoutMs: options.timeoutMs,
    ...(options.maxTimeoutMs !== undefined ? { maxTimeoutMs: options.maxTimeoutMs } : {}),
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    inheritEnv: false,
    env: HOST_ENVIRONMENT
  });"""
replace('src/core/verification-sandbox.ts', old2, new2)

print('strict TypeScript diagnostics corrected')
