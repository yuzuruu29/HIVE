import { VIOLET_GRADIENT, gradientText, stripAnsi, bgRgb, reset, interpolateColor, applyBrightness } from "./colors.js";

export type PixelWordmarkOptions = {
  colorEnabled: boolean;
  width?: "wide" | "compact";
  scanlines?: boolean;
};

const HIVE_PIXEL_MATRIX = {
  H: [
    "11100111",
    "11100111",
    "11100111",
    "11111111",
    "11111111",
    "11100111",
    "11100111",
    "11100111"
  ],
  I: [
    "111111",
    "001100",
    "001100",
    "001100",
    "001100",
    "001100",
    "001100",
    "111111"
  ],
  V: [
    "11000011",
    "11000011",
    "11000011",
    "01100110",
    "01100110",
    "00111100",
    "00111100",
    "00011000"
  ],
  E: [
    "11111111",
    "11111111",
    "11000000",
    "11111100",
    "11111100",
    "11000000",
    "11111111",
    "11111111"
  ]
};

export function renderHivePixelWordmark(options: PixelWordmarkOptions): string[] {
  const { colorEnabled, scanlines = true, width = "wide" } = options;
  const letters = [HIVE_PIXEL_MATRIX.H, HIVE_PIXEL_MATRIX.I, HIVE_PIXEL_MATRIX.V, HIVE_PIXEL_MATRIX.E];
  const spacing = 2; // 2 pixels space between letters
  const rows = 8;
  const result: string[] = [];

  // Calculate total matrix width in pixels
  let totalWidth = 0;
  for (let i = 0; i < letters.length; i++) {
    totalWidth += letters[i][0].length;
    if (i < letters.length - 1) totalWidth += spacing;
  }

  for (let r = 0; r < rows; r++) {
    let rowStr = "";
    let globalCol = 0;
    
    // Slight scanline effect alternating row brightness
    const rowBrightness = scanlines ? (r % 2 === 0 ? 1.0 : 0.8) : 1.0;

    for (let l = 0; l < letters.length; l++) {
      const letterRows = letters[l];
      const rowData = letterRows[r];

      for (let c = 0; c < rowData.length; c++) {
        const isFilled = rowData[c] === '1';
        
        if (colorEnabled) {
          if (isFilled) {
            const t = globalCol / Math.max(1, totalWidth - 1);
            const baseColor = interpolateColor(VIOLET_GRADIENT, t);
            const finalColor = applyBrightness(baseColor, rowBrightness);
            rowStr += bgRgb(finalColor.r, finalColor.g, finalColor.b, "  ");
          } else {
            rowStr += "  ";
          }
        } else {
          rowStr += isFilled ? "##" : "  ";
        }
        globalCol++;
      }

      if (l < letters.length - 1) {
        rowStr += " ".repeat(spacing * 2);
        globalCol += spacing;
      }
    }
    result.push(rowStr);
  }

  return result;
}


export function getWideHiveTitle(color: boolean = true): string[] {
  const lines = [
    "HH   HH  IIIIII  VV    VV  EEEEEEE",
    "HH   HH    II    VV    VV  EE     ",
    "HHHHHHH    II    VV    VV  EEEEE  ",
    "HH   HH    II     VV  VV   EE     ",
    "HH   HH  IIIIII    VVVV    EEEEEEE"
  ];
  if (!color) return lines;
  return lines.map(line => gradientText(line, VIOLET_GRADIENT));
}

export function getLargeHiveTitle(color: boolean = true): string[] {
  const lines = [
    "H   H  III  V   V  EEEEE",
    "H   H   I   V   V  E    ",
    "HHHHH   I   V   V  EEEE ",
    "H   H   I    V V   E    ",
    "H   H  III    V    EEEEE"
  ];
  if (!color) return lines;
  return lines.map(line => gradientText(line, VIOLET_GRADIENT));
}

export function getCompactHiveTitle(color: boolean = true): string[] {
  // Alias for tests/compatibility
  return getLargeHiveTitle(color);
}

export function getLargeHoneycombAscii(color: boolean = true): string[] {
  const lines = [
    "   __    __   ",
    "  /  \\__/  \\  ",
    "  \\__/  \\__/  ",
    "     \\__/     "
  ];
  if (!color) return lines;
  return lines.map(line => gradientText(line, VIOLET_GRADIENT));
}

export function getSmallHoneycombAscii(color: boolean = true): string[] {
  const lines = [
    "  __  __  ",
    " /  \\/  \\ ",
    " \\__/\\__/ ",
    "   \\__/   "
  ];
  if (!color) return lines;
  return lines.map(line => gradientText(line, VIOLET_GRADIENT));
}

export function getQueenBeeAscii(color: boolean = true): string[] {
  const lines = [
    "        /\\_/\\",
    "     __/ o o \\__",
    "   /__   *   __\\",
    "      \\_|||_/",
    "       /_|_\\"
  ];
  if (!color) return lines;
  return lines.map(line => gradientText(line, VIOLET_GRADIENT));
}

export function getCompactQueenBeeAscii(color: boolean = true): string[] {
  const lines = [
    " /\\_/\\ ",
    "/ o o \\",
    "\\_|||_/",
    " /_|_\\ "
  ];
  if (!color) return lines;
  return lines.map(line => gradientText(line, VIOLET_GRADIENT));
}

export function getHiveTextBanner(color: boolean = true): string {
  const text = "HIVE - Verified Agentic Coding";
  if (!color) return text;
  return gradientText(text, VIOLET_GRADIENT);
}

export function renderHiveCompactHeader(options?: { color?: boolean, suffix?: string }): string {
  const useColor = options?.color ?? true;
  const suffix = options?.suffix ? ` - ${options.suffix}` : "";
  const text = `HIVE${suffix} - Verified Agentic Coding`;
  if (!useColor) return text;
  return gradientText(text, VIOLET_GRADIENT);
}
