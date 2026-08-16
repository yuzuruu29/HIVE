// CI Validation Runner
// Runs all tests plus link validation and JSON linting
// No external dependencies required

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STEPS = [
  { name: 'Contract tests', cmd: 'node', args: ['tests/contracts/handoff-schema.test.js'] },
  { name: 'Template tests', cmd: 'node', args: ['tests/contracts/yaml-templates.test.js'] },
  { name: 'Preset tests', cmd: 'node', args: ['tests/scenarios/preset-selection.test.js'] },
  { name: 'Safety tests', cmd: 'node', args: ['tests/scenarios/safety-validation.test.js'] },
  { name: 'Link validation', cmd: 'node', args: ['tests/validate-links.js'] },
  { name: 'JSON validation', cmd: 'node', args: ['-e', "const f=['package.json','skill.json','plugin.json'];f.forEach(p=>{try{const c=require('fs').readFileSync(p,'utf8');JSON.parse(c);console.log('OK: '+p)}catch(e){console.error('FAIL: '+p);process.exit(1)}})" ] }
];

let exitCode = 0;

function runStep(step) {
  return new Promise((resolve) => {
    console.log(`\n=== ${step.name} ===`);
    const proc = spawn(step.cmd, step.args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env }
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`FAIL: ${step.name} exited with code ${code}`);
        exitCode = 1;
      } else {
        console.log(`PASS: ${step.name}`);
      }
      resolve();
    });
    proc.on('error', (err) => {
      console.error(`FAIL: ${step.name} — ${err.message}`);
      exitCode = 1;
      resolve();
    });
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('  The Hive Skill v0.2.0 — CI Validation Suite');
  console.log('='.repeat(60));

  for (const step of STEPS) {
    await runStep(step);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`  CI Suite: ${exitCode === 0 ? 'ALL PASSED' : 'SOME FAILED'}`);
  console.log('='.repeat(60));
  process.exit(exitCode);
}

main();
