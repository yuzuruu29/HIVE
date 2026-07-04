export const VIOLET_GRADIENT = [
  { r: 91, g: 33, b: 182 },   // deep violet
  { r: 124, g: 58, b: 237 },  // vivid violet
  { r: 167, g: 139, b: 250 }, // lavender
  { r: 221, g: 214, b: 254 }  // pale highlight
];

export const TERMINAL_LINE_GRADIENT = [
  { r: 91, g: 33, b: 182 },   // #5B21B6
  { r: 139, g: 92, b: 246 },  // #8B5CF6
  { r: 221, g: 214, b: 254 }, // #DDD6FE
  { r: 139, g: 92, b: 246 },  // #8B5CF6
  { r: 91, g: 33, b: 182 }    // #5B21B6
];

export const BRAND_COLORS = {
  primary: { r: 91, g: 33, b: 182 },
  primary_bright: { r: 124, g: 58, b: 237 },
  accent: { r: 139, g: 92, b: 246 },
  text: { r: 229, g: 231, b: 235 }, // #E5E7EB
  muted: { r: 156, g: 163, b: 175 }, // #9CA3AF
  dim: { r: 107, g: 114, b: 128 }, // #6B7280
  success: { r: 34, g: 197, b: 94 } // #22C55E
};

export function rgbToAnsi256(r: number, g: number, b: number): string {
  return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`;
}

export function applyColor(text: string, r: number, g: number, b: number): string {
  if (!text) return "";
  const ansi = rgbToAnsi256(r, g, b);
  const reset = '\x1b[0m';
  return `${ansi}${text}${reset}`;
}

export function stripAnsi(input: string): string {
  if (!input) return "";
  return input.replace(/\x1b\[[0-9;]*m/g, '');
}

export function bgRgb(r: number, g: number, b: number, text?: string): string {
  const bg = `\x1b[48;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`;
  if (text !== undefined) {
    return `${bg}${text}\x1b[0m`;
  }
  return bg;
}

export function reset(): string {
  return '\x1b[0m';
}

function interpolate(start: number, end: number, factor: number): number {
  return start + (end - start) * factor;
}

export function interpolateColor(stops: Array<{r: number, g: number, b: number}>, t: number): {r: number, g: number, b: number} {
  if (stops.length === 0) return {r: 0, g: 0, b: 0};
  if (stops.length === 1) return stops[0];
  
  const clampedT = Math.max(0, Math.min(1, t));
  const scaledRatio = clampedT * (stops.length - 1);
  const stopIdx = Math.floor(scaledRatio);
  
  if (stopIdx >= stops.length - 1) {
    return stops[stops.length - 1];
  }
  
  const remainder = scaledRatio - stopIdx;
  const startColor = stops[stopIdx];
  const endColor = stops[stopIdx + 1];
  
  return {
    r: Math.round(interpolate(startColor.r, endColor.r, remainder)),
    g: Math.round(interpolate(startColor.g, endColor.g, remainder)),
    b: Math.round(interpolate(startColor.b, endColor.b, remainder))
  };
}

export function applyBrightness(rgb: {r: number, g: number, b: number}, factor: number): {r: number, g: number, b: number} {
  return {
    r: Math.round(Math.min(255, Math.max(0, rgb.r * factor))),
    g: Math.round(Math.min(255, Math.max(0, rgb.g * factor))),
    b: Math.round(Math.min(255, Math.max(0, rgb.b * factor)))
  };
}

export function gradientText(text: string, stops: Array<{r: number, g: number, b: number}>): string {
  if (!text) return "";
  if (stops.length === 0) return text;
  if (stops.length === 1) return applyColor(text, stops[0].r, stops[0].g, stops[0].b);

  let result = "";
  const maxIdx = Math.max(text.length - 1, 1);
  for (let i = 0; i < text.length; i++) {
    if (text[i] === " " || text[i] === "\n") {
      result += text[i];
      continue;
    }
    const ratio = i / maxIdx;
    const scaledRatio = ratio * (stops.length - 1);
    const stopIdx = Math.floor(scaledRatio);
    
    if (stopIdx >= stops.length - 1) {
      const s = stops[stops.length - 1];
      result += applyColor(text[i], s.r, s.g, s.b);
      continue;
    }
    
    const remainder = scaledRatio - stopIdx;
    const startColor = stops[stopIdx];
    const endColor = stops[stopIdx + 1];
    
    const r = interpolate(startColor.r, endColor.r, remainder);
    const g = interpolate(startColor.g, endColor.g, remainder);
    const b = interpolate(startColor.b, endColor.b, remainder);
    
    result += applyColor(text[i], r, g, b);
  }
  return result;
}
