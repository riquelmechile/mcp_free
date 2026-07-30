export type AccessMode = 'observe' | 'workspace' | 'full';
export type RiskTier = 0 | 1 | 2 | 3;

export interface CommandResult {
  argv: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ActionReceipt {
  id: string;
  timestamp: string;
  action: string;
  riskTier: RiskTier;
  mode: AccessMode;
  requestId?: string;
  target?: string;
  command?: string[];
  success: boolean;
  durationMs: number;
  exitCode?: number | null;
  outputSha256?: string;
  details: Record<string, unknown>;
}

export interface DesktopCapabilities {
  sessionType: string;
  desktop: string;
  compositor: string;
  screenshot: string | null;
  clipboardRead: string | null;
  clipboardWrite: string | null;
  pointer: string | null;
  keyboard: string | null;
  windows: string | null;
}
