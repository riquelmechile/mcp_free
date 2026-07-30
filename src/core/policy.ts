import path from 'node:path';
import { config } from '../config.js';
import type { RiskTier } from '../types.js';

const HIGH_RISK = [
  /(^|\s)(sudo|doas|su)(\s|$)/i,
  /(^|\s)(rm\s+-rf|mkfs|fdisk|parted|wipefs|dd\s+if=)(\s|$)/i,
  /(^|\s)(shutdown|reboot|poweroff|halt)(\s|$)/i,
  /(^|\s)(iptables|nft|ufw|firewall-cmd)(\s|$)/i,
  /(^|\s)(userdel|groupdel|passwd)(\s|$)/i,
  /curl[^|]*\|\s*(sh|bash|zsh)/i,
  /wget[^|]*\|\s*(sh|bash|zsh)/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\};:/
];

const MEDIUM_RISK = [
  /(^|\s)(pacman|paru|yay|npm\s+(install|uninstall)|pip\s+(install|uninstall)|go\s+install)(\s|$)/i,
  /(^|\s)(systemctl|loginctl|mount|umount|chown|chmod)(\s|$)/i,
  /(^|\s)(git\s+(push|reset|clean|rebase)|docker\s+(rm|rmi|system\s+prune))(\s|$)/i,
  />\s*\/etc\//i
];

export function classifyCommand(command: string): RiskTier {
  if (HIGH_RISK.some(pattern => pattern.test(command))) return 3;
  if (MEDIUM_RISK.some(pattern => pattern.test(command))) return 2;
  if (/\b(rm|mv|cp|kill|pkill|truncate|sed\s+-i)\b/i.test(command)) return 1;
  return 0;
}

export function classifyFileAction(action: 'write' | 'move' | 'delete', target: string, permanent = false): RiskTier {
  if (action === 'delete' && permanent) return 3;
  if (target.startsWith('/etc/') || target.startsWith('/usr/') || target.startsWith('/boot/')) return 2;
  if (action === 'delete') return 2;
  if (action === 'move') return 1;
  return 1;
}

export function requireConfirmation(riskTier: RiskTier, confirmed: boolean | undefined): void {
  if (riskTier >= 2 && confirmed !== true) {
    throw new Error(`This action is risk tier ${riskTier} and requires confirm=true after explicit user approval.`);
  }
}

export function assertFullMode(capability: string): void {
  if (config.mode !== 'full') {
    throw new Error(`${capability} requires MCP_MODE=full`);
  }
}

export function describePolicy(): Record<string, unknown> {
  return {
    mode: config.mode,
    allowedRoots: config.allowedRoots.map(root => path.resolve(root)),
    allowSecrets: config.allowSecrets,
    confirmationRule: 'risk tier 2 or 3 requires confirm=true',
    fullMode: 'arbitrary shell, process termination, permanent delete, and input injection'
  };
}
