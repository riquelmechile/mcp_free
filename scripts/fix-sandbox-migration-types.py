#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def replace_if_needed(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text()
    if new in content:
        return
    if old not in content:
        raise SystemExit(f'expected text not found in {path}: {old[:120]!r}')
    target.write_text(content.replace(old, new, 1))

replace_if_needed(
    'src/core/safe-fs.ts',
    """    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs""",
    """    dev: Number(metadata.dev),
    ino: Number(metadata.ino),
    mode: Number(metadata.mode),
    size: Number(metadata.size),
    mtimeMs: Number(metadata.mtimeMs)"""
)

replace_if_needed(
    'tests/config-security.test.ts',
    """  const environment = {
    ...process.env,
    MCP_MODE: 'workspace',
    MCP_VERIFICATION_SANDBOX: '1',
    MCP_SANDBOX_CI_BYPASS: '1',
    CI: 'true'
  };""",
    """  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_MODE: 'workspace',
    MCP_VERIFICATION_SANDBOX: '1',
    MCP_SANDBOX_CI_BYPASS: '1',
    CI: 'true'
  };"""
)

replace_if_needed(
    'tests/config-security.test.ts',
    """  const environment = {
    ...process.env,
    MCP_MODE: 'workspace',
    MCP_VERIFICATION_SANDBOX: '0'
  };""",
    """  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_MODE: 'workspace',
    MCP_VERIFICATION_SANDBOX: '0'
  };"""
)

print('strict migration types normalized')
