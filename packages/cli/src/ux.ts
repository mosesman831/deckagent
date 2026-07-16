export type Output = Pick<typeof console, 'log' | 'error'>;

type ColorName = 'red' | 'green' | 'yellow' | 'blue' | 'cyan' | 'bold' | 'dim';

const COLOR_CODES: Record<ColorName, [number, number]> = {
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  cyan: [36, 39],
  bold: [1, 22],
  dim: [2, 22]
};

export function supportsColor(output: Output = console): boolean {
  if (process.env.NO_COLOR) {
    return false;
  }
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') {
    return true;
  }
  return output === console && Boolean(process.stdout.isTTY);
}

export function color(text: string, name: ColorName, enabled: boolean): string {
  if (!enabled) {
    return text;
  }
  const [open, close] = COLOR_CODES[name];
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

export function sectionTitle(title: string, enabled: boolean): string {
  return color(`== ${title} ==`, 'bold', enabled);
}

export function commandLine(command: string, enabled: boolean): string {
  return color(command, 'cyan', enabled);
}

export function statusText(status: 'pass' | 'fail' | 'warn' | 'skip', enabled: boolean): string {
  const label = status.toUpperCase().padEnd(4);
  if (status === 'pass') return color(label, 'green', enabled);
  if (status === 'fail') return color(label, 'red', enabled);
  if (status === 'warn') return color(label, 'yellow', enabled);
  return color(label, 'dim', enabled);
}
