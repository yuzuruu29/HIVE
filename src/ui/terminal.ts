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
  return process.stdout && process.stdout.isTTY === true;
}

export function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, '');
}
