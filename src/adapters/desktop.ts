import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commandExists, runCommand } from '../core/command.js';
import type { DesktopCapabilities } from '../types.js';

async function firstAvailable(commands: string[]): Promise<string | null> {
  for (const command of commands) {
    if (await commandExists(command)) return command;
  }
  return null;
}

export async function detectDesktopCapabilities(): Promise<DesktopCapabilities> {
  const sessionType = process.env.XDG_SESSION_TYPE ?? 'unknown';
  const desktop = process.env.XDG_CURRENT_DESKTOP ?? process.env.DESKTOP_SESSION ?? 'unknown';
  const compositor = process.env.HYPRLAND_INSTANCE_SIGNATURE ? 'hyprland' : desktop.toLowerCase().includes('kde') ? 'kwin' : 'unknown';
  return {
    sessionType,
    desktop,
    compositor,
    screenshot: await firstAvailable(['grim', 'spectacle', 'gnome-screenshot', 'scrot', 'import']),
    clipboardRead: await firstAvailable(['wl-paste', 'xclip', 'xsel']),
    clipboardWrite: await firstAvailable(['wl-copy', 'xclip', 'xsel']),
    pointer: await firstAvailable(['ydotool', 'xdotool']),
    keyboard: await firstAvailable(['wtype', 'ydotool', 'xdotool']),
    windows: await firstAvailable(['kdotool', 'hyprctl', 'wmctrl', 'xdotool'])
  };
}

export async function captureScreenshot(): Promise<{ data: string; mimeType: 'image/png'; backend: string }> {
  const backend = await firstAvailable(['grim', 'spectacle', 'gnome-screenshot', 'scrot', 'import']);
  if (!backend) throw new Error('No screenshot backend found. Install spectacle or grim.');
  const file = path.join(os.tmpdir(), `mcp-free-${randomUUID()}.png`);
  let argv: string[];
  if (backend === 'grim') argv = ['grim', file];
  else if (backend === 'spectacle') argv = ['spectacle', '-b', '-n', '-o', file];
  else if (backend === 'gnome-screenshot') argv = ['gnome-screenshot', '-f', file];
  else if (backend === 'scrot') argv = ['scrot', file];
  else argv = ['import', '-window', 'root', file];
  const result = await runCommand(argv, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || `Screenshot failed using ${backend}`);
  const data = (await fs.readFile(file)).toString('base64');
  await fs.rm(file, { force: true });
  return { data, mimeType: 'image/png', backend };
}

export async function clipboardRead(): Promise<{ text: string; backend: string }> {
  const backend = await firstAvailable(['wl-paste', 'xclip', 'xsel']);
  if (!backend) throw new Error('No clipboard backend found. Install wl-clipboard.');
  const argv = backend === 'wl-paste' ? ['wl-paste', '--no-newline'] : backend === 'xclip' ? ['xclip', '-selection', 'clipboard', '-o'] : ['xsel', '--clipboard', '--output'];
  const result = await runCommand(argv, { timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Clipboard read failed');
  return { text: result.stdout, backend };
}

export async function clipboardWrite(text: string): Promise<string> {
  const backend = await firstAvailable(['wl-copy', 'xclip', 'xsel']);
  if (!backend) throw new Error('No clipboard backend found. Install wl-clipboard.');
  const argv = backend === 'wl-copy' ? ['wl-copy'] : backend === 'xclip' ? ['xclip', '-selection', 'clipboard'] : ['xsel', '--clipboard', '--input'];
  const result = await runCommand(argv, { timeoutMs: 10_000, stdin: text });
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Clipboard write failed');
  return backend;
}

export async function listWindows(): Promise<{ backend: string; windows: string }> {
  const backend = await firstAvailable(['kdotool', 'hyprctl', 'wmctrl', 'xdotool']);
  if (!backend) throw new Error('No window backend found. Install kdotool on KDE Wayland or wmctrl on X11.');
  const argv = backend === 'kdotool'
    ? ['kdotool', 'search', '--name', '.*', 'getwindowname', '%@']
    : backend === 'hyprctl'
      ? ['hyprctl', 'clients', '-j']
      : backend === 'wmctrl'
        ? ['wmctrl', '-lx']
        : ['xdotool', 'search', '--name', '.*', 'getwindowname', '%@'];
  const result = await runCommand(argv, { timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Window listing failed');
  return { backend, windows: result.stdout };
}

export async function focusWindow(query: string): Promise<string> {
  if (await commandExists('kdotool')) {
    const search = await runCommand(['kdotool', 'search', '--name', query]);
    const id = search.stdout.split('\n').find(Boolean);
    if (!id) throw new Error(search.stderr || 'No KDE window matched the query');
    const result = await runCommand(['kdotool', 'windowactivate', id]);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'KDE window focus failed');
    return 'kdotool';
  }
  if (await commandExists('hyprctl')) {
    const result = await runCommand(['hyprctl', 'dispatch', 'focuswindow', `title:${query}`]);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Hyprland window focus failed');
    return 'hyprctl';
  }
  if (await commandExists('wmctrl')) {
    const result = await runCommand(['wmctrl', '-a', query]);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'wmctrl window focus failed');
    return 'wmctrl';
  }
  throw new Error('No supported window-focus backend found');
}

export async function pointerClick(x: number, y: number, button: 'left' | 'middle' | 'right'): Promise<string> {
  if (await commandExists('ydotool')) {
    const mask = button === 'left' ? '0xC0' : button === 'right' ? '0xC1' : '0xC2';
    const move = await runCommand(['ydotool', 'mousemove', '--absolute', '-x', String(x), '-y', String(y)]);
    if (move.exitCode !== 0) throw new Error(move.stderr || 'ydotool mousemove failed');
    const click = await runCommand(['ydotool', 'click', mask]);
    if (click.exitCode !== 0) throw new Error(click.stderr || 'ydotool click failed');
    return 'ydotool';
  }
  if (await commandExists('xdotool')) {
    const number = button === 'left' ? '1' : button === 'middle' ? '2' : '3';
    const result = await runCommand(['xdotool', 'mousemove', '--sync', String(x), String(y), 'click', number]);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'xdotool click failed');
    return 'xdotool';
  }
  throw new Error('No pointer backend found. Install and configure ydotool.');
}

export async function typeText(text: string, delayMs: number): Promise<string> {
  if (await commandExists('wtype')) {
    const result = await runCommand(['wtype', '-d', String(delayMs), '--', text], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'wtype failed');
    return 'wtype';
  }
  if (await commandExists('ydotool')) {
    const result = await runCommand(['ydotool', 'type', '--key-delay', String(delayMs), text], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'ydotool type failed');
    return 'ydotool';
  }
  if (await commandExists('xdotool')) {
    const result = await runCommand(['xdotool', 'type', '--delay', String(delayMs), '--', text], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'xdotool type failed');
    return 'xdotool';
  }
  throw new Error('No keyboard backend found');
}

const linuxKeyCodes: Record<string, number> = {
  ctrl: 29, alt: 56, shift: 42, super: 125, meta: 125, enter: 28, return: 28,
  escape: 1, esc: 1, tab: 15, backspace: 14, space: 57, delete: 111,
  up: 103, down: 108, left: 105, right: 106, home: 102, end: 107,
  pageup: 104, pagedown: 109, insert: 110,
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36,
  k: 37, l: 38, m: 50, n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20,
  u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  '0': 11, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88
};

function ydotoolKeySequence(combo: string): string[] {
  const names = combo.toLowerCase().split('+').map(value => value.trim()).filter(Boolean);
  if (names.length === 0) throw new Error('Invalid key combo');
  const codes = names.map(name => linuxKeyCodes[name]);
  if (codes.some(code => code === undefined)) throw new Error(`Unsupported ydotool key in combo: ${combo}`);
  return [
    ...codes.map(code => `${code}:1`),
    ...codes.slice().reverse().map(code => `${code}:0`)
  ];
}

export async function sendKey(combo: string): Promise<string> {
  if (await commandExists('wtype')) {
    const modifiers = combo.toLowerCase().split('+');
    const key = modifiers.pop();
    if (!key) throw new Error('Invalid key combo');
    const modFlags = modifiers.flatMap(mod => ['-M', mod === 'ctrl' ? 'CTRL' : mod === 'alt' ? 'ALT' : mod === 'shift' ? 'SHIFT' : mod === 'super' ? 'LOGO' : mod]);
    const result = await runCommand(['wtype', ...modFlags, '-k', key, ...modifiers.flatMap(mod => ['-m', mod === 'ctrl' ? 'CTRL' : mod === 'alt' ? 'ALT' : mod === 'shift' ? 'SHIFT' : mod === 'super' ? 'LOGO' : mod])]);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'wtype key failed');
    return 'wtype';
  }
  if (await commandExists('ydotool')) {
    const result = await runCommand(['ydotool', 'key', ...ydotoolKeySequence(combo)]);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'ydotool key failed');
    return 'ydotool';
  }
  if (await commandExists('xdotool')) {
    const result = await runCommand(['xdotool', 'key', '--clearmodifiers', combo]);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'xdotool key failed');
    return 'xdotool';
  }
  throw new Error('Key-combo support requires wtype, ydotool, or xdotool.');
}

export async function scroll(vertical: number, horizontal: number): Promise<string> {
  if (await commandExists('ydotool')) {
    const result = await runCommand(['ydotool', 'mousemove', '--wheel', '-x', String(horizontal), '-y', String(vertical)]);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'ydotool scroll failed');
    return 'ydotool';
  }
  if (await commandExists('xdotool')) {
    const clicks: string[] = [];
    const append = (button: number, count: number) => { for (let i = 0; i < Math.abs(count); i += 1) clicks.push('click', String(button)); };
    append(vertical < 0 ? 4 : 5, vertical);
    append(horizontal < 0 ? 6 : 7, horizontal);
    const result = await runCommand(['xdotool', ...clicks]);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'xdotool scroll failed');
    return 'xdotool';
  }
  throw new Error('No scroll backend found');
}
