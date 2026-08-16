// Link Validation Script
// Checks that all relative Markdown links resolve to existing files
// Ignores links inside fenced code blocks (backtick ``` and tilde ~~~)
// No external dependencies required

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXCLUDE_DIRS = ['node_modules', 'hive-ad', 'assets/promo', '.git'];
const EXCLUDE_FILES = ['link-validator-regression.md'];

let errors = 0;
let checked = 0;

/**
 * Strip fenced code blocks from Markdown content so links inside them
 * are not validated. Supports backtick (```) and tilde (~~~) fences.
 */
function stripFencedBlocks(content) {
  // Match fenced code blocks opened with ``` or ~~~
  // The closing fence must use the same characters (``` or ~~~)
  return content.replace(/^[ \t]*(```+|~~~+)[\s\S]*?^[ \t]*\1[ \t]*$/gm, '');
}

module.exports = { stripFencedBlocks };

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.includes(entry.name)) walk(full);
    } else if (entry.name.endsWith('.md') && !EXCLUDE_FILES.includes(entry.name)) {
      checkLinks(full);
    }
  }
}

function checkLinks(filePath) {
  const rawContent = fs.readFileSync(filePath, 'utf8');
  // Strip fenced code blocks before extracting links
  const content = stripFencedBlocks(rawContent);
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const fileDir = path.dirname(filePath);
  let match;

  while ((match = linkRegex.exec(content)) !== null) {
    const link = match[2];
    // Skip absolute URLs, fragments, mailto
    if (link.startsWith('http://') || link.startsWith('https://') ||
        link.startsWith('mailto:') || link.startsWith('#')) continue;

    // Resolve relative to the file's directory
    const resolved = path.resolve(fileDir, link);
    checked++;
    if (!fs.existsSync(resolved)) {
      const rel = path.relative(ROOT, filePath);
      console.error(`BROKEN: ${rel} -> ${link} (not found)`);
      errors++;
    }
  }
}

if (require.main === module) {
  console.log('Validating Markdown links...\n');
  walk(ROOT);
  console.log(`\nChecked ${checked} links, ${errors} broken`);
  process.exit(errors > 0 ? 1 : 0);
}
