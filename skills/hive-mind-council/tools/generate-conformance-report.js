// The Hive Skill v0.3.0 — Conformance Report Generator
// Reads all adapter manifests and generates docs/CONFORMANCE.md
// Usage:
//   node tools/generate-conformance-report.js          # write report
//   node tools/generate-conformance-report.js --check   # verify report is current

'use strict';

const fs = require('fs');
const path = require('path');

const ADAPTERS_DIR = path.resolve(__dirname, '..', 'adapters');
const OUTPUT_FILE = path.resolve(__dirname, '..', 'docs', 'CONFORMANCE.md');

/**
 * Load and parse a JSON file.
 */
function loadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get a display-friendly adapter name from directory name.
 */
function displayName(dirName) {
  switch (dirName) {
    case 'opencode':
      return 'OpenCode';
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'generic-agents':
      return 'Generic';
    default:
      return dirName;
  }
}

/**
 * Get validation status text from adapter manifest validation object.
 */
function validationStatus(validation) {
  if (!validation) return 'Unknown';
  switch (validation.test_status) {
    case 'structural_only':
      return 'Structural only';
    case 'manual_live':
      return 'Manual live';
    case 'automated_live':
      return 'Automated live';
    case 'runtime_native':
      return 'Runtime native';
    default:
      return validation.test_status || 'Unknown';
  }
}

/**
 * Generate the conformance report markdown.
 */
function generateReport(adapters) {
  const lines = [];
  lines.push('# Adapter Conformance');
  lines.push('');
  lines.push('| Adapter | Declared level | Validation | Protocol | Last tested |');
  lines.push('|---|---:|---|---|---|');

  for (const adapter of adapters.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = displayName(adapter.dir);
    const level = adapter.manifest.declared_conformance_level;
    const validation = validationStatus(adapter.manifest.validation);
    const protocol = adapter.manifest.supported_protocol_versions?.minimum || '?';
    const lastTested = adapter.manifest.validation?.last_tested_at || 'Never';
    lines.push(`| ${name} | ${level} | ${validation} | ${protocol} | ${lastTested} |`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Normalize line endings: replace CRLF with LF for consistent comparison.
 */
function normalizeEOL(text) {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Load all adapter manifests and generate expected report content.
 * Returns { markdown, adapters } — the generated text and the adapter data.
 */
function loadAndGenerate() {
  let adapterDirs;
  try {
    adapterDirs = fs.readdirSync(ADAPTERS_DIR).filter((f) => {
      const stat = fs.statSync(path.join(ADAPTERS_DIR, f));
      return stat.isDirectory();
    });
  } catch (err) {
    console.error(`ERROR: Could not read adapters directory: ${err.message}`);
    process.exit(1);
  }

  if (adapterDirs.length === 0) {
    console.error('ERROR: No adapter directories found.');
    process.exit(1);
  }

  const adapters = [];
  for (const dir of adapterDirs) {
    const manifestPath = path.join(ADAPTERS_DIR, dir, 'adapter.json');
    if (!fs.existsSync(manifestPath)) {
      console.warn(`WARNING: No adapter.json found in ${dir}, skipping.`);
      continue;
    }

    const loaded = loadJSON(manifestPath);
    if (!loaded.ok) {
      console.warn(`WARNING: Failed to parse ${manifestPath}: ${loaded.error}`);
      continue;
    }

    adapters.push({ dir, name: dir, manifest: loaded.data });
  }

  if (adapters.length === 0) {
    console.error('ERROR: No valid adapter manifests loaded.');
    process.exit(1);
  }

  return { markdown: generateReport(adapters), adapters };
}

/**
 * Check mode: generate report in memory and compare with the tracked file.
 * Exits 0 if identical, 1 if stale or missing.
 */
function checkMode() {
  const { markdown } = loadAndGenerate();
  const expected = normalizeEOL(markdown);

  if (!fs.existsSync(OUTPUT_FILE)) {
    console.error('CONFORMANCE.md is missing. Run `node tools/generate-conformance-report.js` to create it.');
    process.exit(1);
  }

  const actual = normalizeEOL(fs.readFileSync(OUTPUT_FILE, 'utf8'));

  if (expected === actual) {
    console.log('PASS: docs/CONFORMANCE.md is up to date.');
    process.exit(0);
  }

  // Show a concise diff
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  console.error('FAIL: docs/CONFORMANCE.md is stale.');
  console.error('');
  console.error('Run `node tools/generate-conformance-report.js` to regenerate it.');
  console.error('');
  console.error('Expected:');
  for (let i = 0; i < expectedLines.length; i++) {
    if (expectedLines[i] !== (actualLines[i] || undefined)) {
      console.error(`  Line ${i + 1}: expected "${expectedLines[i]}"`);
      if (actualLines[i] !== undefined) {
        console.error(`            actual   "${actualLines[i]}"`);
      } else {
        console.error(`            actual   (missing line)`);
      }
    }
  }
  for (let i = expectedLines.length; i < actualLines.length; i++) {
    console.error(`  Line ${i + 1}: expected (no more lines) actual "${actualLines[i]}"`);
  }
  process.exit(1);
}

/**
 * Write mode: generate report and write to file.
 */
function writeMode() {
  console.log('The Hive Skill — Conformance Report Generator');
  console.log('='.repeat(50));

  const { markdown, adapters } = loadAndGenerate();
  for (const a of adapters) {
    console.log(`  Loaded: ${a.dir} (Level ${a.manifest.declared_conformance_level})`);
  }

  try {
    fs.writeFileSync(OUTPUT_FILE, markdown, 'utf8');
    console.log(`\nReport written to: ${OUTPUT_FILE}`);
  } catch (err) {
    console.error(`ERROR: Could not write report: ${err.message}`);
    process.exit(1);
  }

  console.log('\n' + markdown);
  console.log('='.repeat(50));
  console.log('Done.');
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    checkMode();
  } else {
    writeMode();
  }
}

main();
