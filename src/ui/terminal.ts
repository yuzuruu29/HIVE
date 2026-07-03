export type RenderMode = 'full' | 'compact' | 'plain' | 'nocolor' | 'suppressed';

export function supportsColorOutput(): boolean {
  if (process.argv.includes('--no-color')) {
    return false;
  }
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') {
    return true;
  }
  return !!process.stdout && process.stdout.isTTY === true;
}

export function isInteractiveOutput(): boolean {
  return !!process.stdout && process.stdout.isTTY === true;
}

export function isCI(): boolean {
  return process.env.CI !== undefined && process.env.CI !== 'false';
}

export function shouldSuppressBranding(): boolean {
  return process.argv.includes('--json');
}

export function safeWidth(): number {
  return process.stdout && process.stdout.columns ? process.stdout.columns : 80;
}

export function getRenderMode(): RenderMode {
  if (shouldSuppressBranding()) {
    return 'suppressed';
  }
  
  const width = safeWidth();
  const interactive = isInteractiveOutput();
  const ci = isCI();
  const color = supportsColorOutput();
  
  if (!interactive || ci || width < 70) {
    return 'plain';
  }
  
  if (!color) {
    return 'nocolor';
  }
  
  if (width >= 100) {
    return 'full';
  }
  
  return 'compact';
}
