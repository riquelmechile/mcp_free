import fs from 'node:fs/promises';
import path from 'node:path';

export type TrustedExecutable =
  | 'bwrap'
  | 'git'
  | 'rg'
  | 'fd'
  | 'ls'
  | 'cat'
  | 'head'
  | 'tail'
  | 'wc'
  | 'jq'
  | 'stat'
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'python'
  | 'python3'
  | 'pytest'
  | 'go'
  | 'cargo'
  | 'make';

const TRUSTED_CANDIDATES: Record<TrustedExecutable, readonly string[]> = {
  bwrap: ['/usr/bin/bwrap'],
  git: ['/usr/bin/git'],
  rg: ['/usr/bin/rg'],
  fd: ['/usr/bin/fd', '/usr/bin/fdfind'],
  ls: ['/usr/bin/ls'],
  cat: ['/usr/bin/cat'],
  head: ['/usr/bin/head'],
  tail: ['/usr/bin/tail'],
  wc: ['/usr/bin/wc'],
  jq: ['/usr/bin/jq'],
  stat: ['/usr/bin/stat'],
  npm: ['/usr/bin/npm', '/usr/local/bin/npm'],
  pnpm: ['/usr/bin/pnpm', '/usr/local/bin/pnpm'],
  yarn: ['/usr/bin/yarn', '/usr/local/bin/yarn'],
  python: ['/usr/bin/python', '/usr/bin/python3'],
  python3: ['/usr/bin/python3'],
  pytest: ['/usr/bin/pytest', '/usr/local/bin/pytest'],
  go: ['/usr/bin/go', '/usr/local/bin/go'],
  cargo: ['/usr/bin/cargo', '/usr/local/bin/cargo'],
  make: ['/usr/bin/make']
};

const TRUSTED_PHYSICAL_ROOTS = ['/usr/bin', '/usr/lib', '/usr/libexec', '/usr/share', '/usr/local/bin', '/usr/local/lib', '/opt/hostedtoolcache'];
const INSPECTION_EXECUTABLES = new Set<TrustedExecutable>(['git', 'rg', 'fd', 'ls', 'cat', 'head', 'tail', 'wc', 'jq', 'stat']);
const VERIFICATION_EXECUTABLES = new Set<TrustedExecutable>(['git', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'pytest', 'go', 'cargo', 'make']);
const SENSITIVE_PATH = /(^|\/)(\.env(?:\.|$)|\.ssh|\.gnupg|\.aws|\.kube|secrets?|credentials?)(\/|$)|\.(?:pem|key)$/i;
const SAFE_SCRIPT = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SAFE_TARGET = /^[A-Za-z0-9][A-Za-z0-9:._/@+~-]{0,255}$/;

interface ParsedArguments {
  positionals: string[];
  tail: string[];
}

interface OptionGrammar {
  noValue?: ReadonlySet<string>;
  value?: ReadonlySet<string>;
  compact?: readonly RegExp[];
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertNoNul(value: string): void {
  if (value.includes('\0')) throw new Error('NUL bytes are not allowed in command arguments');
}

function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]+/).some(component => component === '..');
}

function assertSafePathToken(value: string): void {
  assertNoNul(value);
  if (value === '-') throw new Error('Standard-input paths are not allowed in persistent inspection commands');
  if (path.isAbsolute(value) || value.startsWith('~') || hasParentTraversal(value)) {
    throw new Error(`Path arguments must stay inside the project: ${value}`);
  }
  if (SENSITIVE_PATH.test(value.replaceAll('\\', '/'))) throw new Error(`Credential-like paths are blocked: ${value}`);
}

function assertSafeOptionValue(value: string): void {
  assertNoNul(value);
  if (path.isAbsolute(value) || value.startsWith('~') || hasParentTraversal(value)) {
    throw new Error(`Option values may not reference paths outside the project: ${value}`);
  }
  if (SENSITIVE_PATH.test(value.replaceAll('\\', '/'))) throw new Error(`Credential-like option values are blocked: ${value}`);
}

function assertLogicalExecutable(argv: string[], allowed: ReadonlySet<TrustedExecutable>, kind: string): TrustedExecutable {
  if (argv.length === 0) throw new Error(`${kind} command must not be empty`);
  if (argv.length > 100) throw new Error(`${kind} command is too long`);
  const logical = argv[0]!;
  assertNoNul(logical);
  if (path.basename(logical) !== logical || logical.includes('/') || logical.includes('\\')) {
    throw new Error(`${kind} executable must be a logical name, never a path: ${logical}`);
  }
  if (!allowed.has(logical as TrustedExecutable)) throw new Error(`${kind} executable is not allowed: ${logical}`);
  return logical as TrustedExecutable;
}

function parseOptions(args: string[], grammar: OptionGrammar): ParsedArguments {
  const positionals: string[] = [];
  const tail: string[] = [];
  let afterDelimiter = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    assertNoNul(argument);
    if (afterDelimiter) {
      tail.push(argument);
      continue;
    }
    if (argument === '--') {
      afterDelimiter = true;
      continue;
    }
    if (!argument.startsWith('-') || argument === '-') {
      positionals.push(argument);
      continue;
    }
    if (grammar.compact?.some(pattern => pattern.test(argument))) continue;
    const equals = argument.indexOf('=');
    const flag = equals >= 0 ? argument.slice(0, equals) : argument;
    if (grammar.noValue?.has(flag)) {
      if (equals >= 0) throw new Error(`Option ${flag} does not accept a value`);
      continue;
    }
    if (grammar.value?.has(flag)) {
      const value = equals >= 0 ? argument.slice(equals + 1) : args[++index];
      if (value === undefined || value === '--') throw new Error(`Option ${flag} requires a value`);
      assertSafeOptionValue(value);
      continue;
    }
    throw new Error(`Command option is not allowed: ${argument}`);
  }
  return { positionals, tail };
}

function assertPaths(paths: string[]): void {
  for (const value of paths) assertSafePathToken(value);
}

function analyzeGit(argv: string[]): string[] {
  const subcommand = argv[1];
  if (!subcommand) throw new Error('Git inspection requires a subcommand');
  const args = argv.slice(2);
  if (subcommand === 'rev-parse') {
    const accepted = new Set([
      JSON.stringify(['--show-toplevel']),
      JSON.stringify(['--is-inside-work-tree']),
      JSON.stringify(['--show-prefix']),
      JSON.stringify(['--verify', 'HEAD']),
      JSON.stringify(['--abbrev-ref', 'HEAD'])
    ]);
    if (!accepted.has(JSON.stringify(args))) throw new Error('git rev-parse is restricted to fixed read-only queries');
    return [];
  }

  if (subcommand === 'status') {
    const parsed = parseOptions(args, {
      noValue: new Set(['--short', '-s', '--branch', '-b', '--porcelain', '--ignored', '--no-ahead-behind']),
      value: new Set(['--untracked-files'])
    });
    if (parsed.positionals.length > 0) throw new Error('git status paths must follow --');
    assertPaths(parsed.tail);
    return parsed.tail;
  }

  if (subcommand === 'diff') {
    if (args.some(argument => argument === '--output' || argument.startsWith('--output='))) {
      throw new Error('Git argument can write files, escape the worktree, or execute configured helpers');
    }
    const parsed = parseOptions(args, {
      noValue: new Set(['--stat', '--name-only', '--name-status', '--numstat', '--check', '--cached', '--staged', '--no-ext-diff', '--no-textconv', '--color=never', '--word-diff']),
      value: new Set(['--unified', '--diff-filter']),
      compact: [/^-U\d+$/]
    });
    if (parsed.positionals.length > 0) throw new Error('git diff revisions and paths are disabled; paths must follow --');
    assertPaths(parsed.tail);
    return parsed.tail;
  }

  if (subcommand === 'log') {
    const parsed = parseOptions(args, {
      noValue: new Set(['--oneline', '--graph', '--all', '--stat', '--name-only', '--name-status', '--no-decorate', '--no-patch', '--no-ext-diff', '--no-textconv', '--color=never']),
      value: new Set(['--max-count', '--since', '--until', '--decorate']),
      compact: [/^-n\d+$/]
    });
    if (parsed.positionals.length > 0) throw new Error('git log revisions are disabled in persistent inspection');
    assertPaths(parsed.tail);
    return parsed.tail;
  }

  if (subcommand === 'show') {
    const parsed = parseOptions(args, {
      noValue: new Set(['--stat', '--name-only', '--name-status', '--no-patch', '--oneline', '--no-ext-diff', '--no-textconv', '--color=never']),
      value: new Set(['--format'])
    });
    if (parsed.positionals.length > 1 || (parsed.positionals[0] && !SAFE_TARGET.test(parsed.positionals[0]))) {
      throw new Error('git show accepts at most one safe object name');
    }
    if (parsed.positionals[0] && SENSITIVE_PATH.test(parsed.positionals[0])) throw new Error('Credential-like git object paths are blocked');
    assertPaths(parsed.tail);
    return parsed.tail;
  }

  if (subcommand === 'grep') {
    const parsed = parseOptions(args, {
      noValue: new Set(['-n', '--line-number', '-I', '-F', '--fixed-strings', '-i', '--ignore-case', '-w', '--word-regexp', '-l', '--files-with-matches'])
    });
    if (parsed.positionals.length !== 1) throw new Error('git grep requires exactly one search pattern before --');
    assertPaths(parsed.tail);
    return parsed.tail;
  }

  if (subcommand === 'ls-files') {
    const parsed = parseOptions(args, {
      noValue: new Set(['-z', '--cached', '--others', '--exclude-standard', '--modified', '--deleted', '--stage', '-s'])
    });
    if (parsed.positionals.length > 0) throw new Error('git ls-files paths must follow --');
    assertPaths(parsed.tail);
    return parsed.tail;
  }

  if (subcommand === 'describe') {
    const parsed = parseOptions(args, {
      noValue: new Set(['--always', '--tags', '--all', '--dirty', '--long']),
      value: new Set(['--abbrev', '--match', '--exclude'])
    });
    if (parsed.tail.length > 0 || parsed.positionals.length > 1 || (parsed.positionals[0] && parsed.positionals[0] !== 'HEAD')) {
      throw new Error('git describe accepts only optional HEAD');
    }
    return [];
  }

  throw new Error(`Git subcommand is not read-only or not supported: ${subcommand}`);
}

function analyzeInspection(argv: string[]): { executable: TrustedExecutable; paths: string[] } {
  const executable = assertLogicalExecutable(argv, INSPECTION_EXECUTABLES, 'Inspection');
  if (executable === 'git') return { executable, paths: analyzeGit(argv) };

  if (executable === 'rg') {
    if (argv.some(argument => argument === '--pre' || argument.startsWith('--pre=') || argument === '--pre-glob' || argument.startsWith('--pre-glob='))) {
      throw new Error('ripgrep preprocessors are not allowed');
    }
    if (argv.includes('--follow') || argv.includes('-L')) throw new Error('ripgrep symlink following is not allowed');
    const parsed = parseOptions(argv.slice(1), {
      noValue: new Set(['--line-number', '-n', '--hidden', '--no-ignore', '--files', '--files-with-matches', '-l', '--count', '--fixed-strings', '-F', '--ignore-case', '-i', '--case-sensitive', '-s', '--smart-case', '-S', '--word-regexp', '-w', '--invert-match', '-v', '--multiline', '-U', '--no-messages']),
      value: new Set(['--glob', '-g', '--type', '-t', '--type-not', '-T', '--max-count', '-m', '--max-depth', '--context', '-C', '--before-context', '-B', '--after-context', '-A'])
    });
    const operands = [...parsed.positionals, ...parsed.tail];
    const filesMode = argv.includes('--files');
    if (!filesMode && operands.length < 1) throw new Error('rg requires one search pattern');
    const paths = filesMode ? operands : operands.slice(1);
    assertPaths(paths);
    return { executable, paths };
  }

  if (executable === 'fd') {
    if (argv.some(argument => ['--exec', '--exec-batch', '-x', '-X'].includes(argument))) throw new Error('fd execution actions are not allowed');
    if (argv.includes('--follow') || argv.includes('-L')) throw new Error('fd symlink following is not allowed');
    const parsed = parseOptions(argv.slice(1), {
      noValue: new Set(['--hidden', '-H', '--no-ignore', '-I', '--glob', '-g', '--fixed-strings', '-F', '--absolute-path', '--color=never']),
      value: new Set(['--exclude', '-E', '--max-depth', '-d', '--type', '-t', '--extension', '-e', '--max-results'])
    });
    const operands = [...parsed.positionals, ...parsed.tail];
    if (operands.length > 2) throw new Error('fd accepts at most one pattern and one project-local root');
    const paths = operands.length === 2 ? [operands[1]!] : [];
    assertPaths(paths);
    return { executable, paths };
  }

  if (executable === 'ls') {
    const parsed = parseOptions(argv.slice(1), {
      noValue: new Set(['-l', '-a', '-h', '-R', '-1', '--all', '--long', '--human-readable', '--recursive', '--color=never']),
      compact: [/^-[lahR1]+$/]
    });
    const paths = [...parsed.positionals, ...parsed.tail];
    assertPaths(paths);
    return { executable, paths };
  }

  if (executable === 'cat') {
    const parsed = parseOptions(argv.slice(1), { noValue: new Set(['-n', '--number', '-b', '--number-nonblank']) });
    const paths = [...parsed.positionals, ...parsed.tail];
    if (paths.length < 1) throw new Error('cat requires at least one project-local file');
    assertPaths(paths);
    return { executable, paths };
  }

  if (executable === 'head' || executable === 'tail') {
    const parsed = parseOptions(argv.slice(1), {
      noValue: new Set(['-q', '--quiet', '-v', '--verbose']),
      value: new Set(['-n', '--lines', '-c', '--bytes']),
      compact: [/^-[nc]\d+$/]
    });
    const paths = [...parsed.positionals, ...parsed.tail];
    if (paths.length < 1) throw new Error(`${executable} requires at least one project-local file`);
    assertPaths(paths);
    return { executable, paths };
  }

  if (executable === 'wc') {
    const parsed = parseOptions(argv.slice(1), {
      noValue: new Set(['-l', '--lines', '-w', '--words', '-c', '--bytes', '-m', '--chars']),
      compact: [/^-[lwcm]+$/]
    });
    const paths = [...parsed.positionals, ...parsed.tail];
    if (paths.length < 1) throw new Error('wc requires at least one project-local file');
    assertPaths(paths);
    return { executable, paths };
  }

  if (executable === 'stat') {
    const parsed = parseOptions(argv.slice(1), {
      noValue: new Set(['-L', '--dereference']),
      value: new Set(['-c', '--format'])
    });
    const paths = [...parsed.positionals, ...parsed.tail];
    if (paths.length < 1) throw new Error('stat requires at least one project-local path');
    assertPaths(paths);
    return { executable, paths };
  }

  if (executable === 'jq') {
    const parsed = parseOptions(argv.slice(1), {
      noValue: new Set(['-r', '--raw-output', '-c', '--compact-output', '-S', '--sort-keys', '-M', '--monochrome-output', '-e', '--exit-status'])
    });
    const operands = [...parsed.positionals, ...parsed.tail];
    if (operands.length < 2) throw new Error('jq requires one filter and at least one project-local JSON file');
    const paths = operands.slice(1);
    assertPaths(paths);
    return { executable, paths };
  }

  throw new Error(`Unsupported inspection executable: ${executable}`);
}

function assertNoEmbeddedEscape(argument: string): void {
  assertNoNul(argument);
  const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argument;
  if (value && (path.isAbsolute(value) || value.startsWith('~') || hasParentTraversal(value))) {
    throw new Error(`Verification arguments may not escape the project: ${argument}`);
  }
  if (value && SENSITIVE_PATH.test(value.replaceAll('\\', '/'))) throw new Error(`Credential-like verification path is blocked: ${argument}`);
}

export function validateInspectionCommand(argv: string[]): void {
  analyzeInspection(argv);
}

export function validateVerificationCommand(argv: string[]): void {
  const executable = assertLogicalExecutable(argv, VERIFICATION_EXECUTABLES, 'Verification');
  for (const argument of argv.slice(1)) assertNoEmbeddedEscape(argument);

  if (executable === 'git') {
    if (JSON.stringify(argv.slice(1)) !== JSON.stringify(['diff', '--check'])) {
      throw new Error('Only git diff --check is allowed as a verification command');
    }
    return;
  }

  if (executable === 'npm' || executable === 'pnpm' || executable === 'yarn') {
    if (argv[1] === 'test' && argv.length === 2) return;
    if (argv[1] === 'run' && argv.length === 3 && SAFE_SCRIPT.test(argv[2]!)) return;
    throw new Error(`${executable} verification must use run or test with a safe script and no extra arguments`);
  }

  if (executable === 'python' || executable === 'python3') {
    if (argv[1] !== '-m' || argv[2] !== 'pytest') throw new Error('Python verification is limited to -m pytest');
    return;
  }

  if (executable === 'pytest') return;

  if (executable === 'go') {
    if (argv[1] !== 'test') throw new Error('Go verification is limited to go test');
    if (argv.some(argument => /^(?:-exec|-toolexec|-coverprofile|-o)(?:=|$)/.test(argument))) {
      throw new Error('Go verification may not select external tools or output files');
    }
    return;
  }

  if (executable === 'cargo') {
    if (argv[1] !== 'test' && argv[1] !== 'check') throw new Error('Cargo verification is limited to cargo test/check');
    if (argv.some(argument => /^(?:--config|--manifest-path|--target-dir)(?:=|$)/.test(argument))) {
      throw new Error('Cargo verification may not override config, manifest, or target directories');
    }
    return;
  }

  if (executable === 'make') {
    if (argv.slice(1).some(argument => argument.startsWith('-') || !SAFE_TARGET.test(argument))) {
      throw new Error('Make verification accepts target names only; Makefile and directory overrides are blocked');
    }
    return;
  }
}

async function assertProjectPaths(root: string, paths: string[]): Promise<void> {
  const realRoot = await fs.realpath(root);
  for (const relative of paths) {
    const candidate = path.resolve(realRoot, relative);
    if (!within(candidate, realRoot)) throw new Error(`Argument resolves outside project: ${relative}`);
    try {
      const metadata = await fs.lstat(candidate);
      if (metadata.isSymbolicLink()) throw new Error(`Explicit symlink arguments are blocked: ${relative}`);
      const physical = await fs.realpath(candidate);
      if (!within(physical, realRoot)) throw new Error(`Argument resolves outside project through filesystem links: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function resolveTrustedExecutable(executable: TrustedExecutable): Promise<string> {
  const candidates = [...TRUSTED_CANDIDATES[executable]];
  if (process.env.CI === 'true' && executable === 'npm' && process.env.npm_execpath && path.isAbsolute(process.env.npm_execpath)) {
    candidates.unshift(process.env.npm_execpath);
  }
  for (const candidate of candidates) {
    try {
      const physical = await fs.realpath(candidate);
      const metadata = await fs.stat(physical);
      if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) continue;
      if (!TRUSTED_PHYSICAL_ROOTS.some(root => within(physical, root))) continue;
      return physical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Trusted root-owned executable is unavailable: ${executable}`);
}

export async function canonicalizeInspectionCommand(argv: string[], root: string): Promise<string[]> {
  const analyzed = analyzeInspection(argv);
  await assertProjectPaths(root, analyzed.paths);
  const executable = await resolveTrustedExecutable(analyzed.executable);
  if (analyzed.executable !== 'git') return [executable, ...argv.slice(1)];
  const subcommand = argv[1]!;
  const rest = [...argv.slice(2)];
  if (subcommand === 'diff' || subcommand === 'log' || subcommand === 'show') {
    if (!rest.includes('--no-ext-diff')) rest.unshift('--no-ext-diff');
    if (!rest.includes('--no-textconv')) rest.unshift('--no-textconv');
    if (!rest.includes('--color=never')) rest.unshift('--color=never');
  }
  return [
    executable,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.pager=cat',
    '-c', 'pager.status=false',
    '-c', 'diff.external=',
    subcommand,
    ...rest
  ];
}

export async function canonicalizeVerificationCommand(argv: string[]): Promise<string[]> {
  validateVerificationCommand(argv);
  const executable = await resolveTrustedExecutable(argv[0] as TrustedExecutable);
  return [executable, ...argv.slice(1)];
}
