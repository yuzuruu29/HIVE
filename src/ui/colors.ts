export const VIOLET_GRADIENT = [
  { r: 91, g: 33, b: 182 },   // deep violet
  { r: 124, g: 58, b: 237 },  // vivid violet
  { r: 167, g: 139, b: 250 }, // lavender
  { r: 221, g: 214, b: 254 }  // pale highlight
];

export function rgbToAnsi256(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function applyColor(text: string, r: number, g: number, b: number): string {
  const ansi = rgbToAnsi256(r, g, b);
  const reset = '\x1b[0m';
  return `${ansi}${text}${reset}`;
}
