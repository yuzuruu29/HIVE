import path from 'path';

/**
 * Directories and files that Scout must absolutely ignore.
 * This ensures no secrets, heavy artifacts, or large histories are read.
 */
const GLOBAL_IGNORES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.hive',
  '.hivemind',
  'logs',
  '.next'
]);

/**
 * Strict check if a path should be ignored by the Scout engine.
 */
export function isIgnoredPath(filePath: string): boolean {
  const parts = filePath.split(path.sep).map(p => p.split('/').join('')).filter(Boolean);
  
  // Check against ignore list for any segment
  for (const part of parts) {
    if (GLOBAL_IGNORES.has(part)) return true;
  }

  // Exact file blocks
  const basename = path.basename(filePath);
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  
  return false;
}
