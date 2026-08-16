// Link Validator Regression Test
// Verifies the validator correctly handles fenced code blocks.
// No external dependencies required.

const path = require('path');
const fs = require('fs');
const { stripFencedBlocks } = require('./validate-links');

let allPassed = true;
let totalChecks = 0;
let passedChecks = 0;

function check(label, condition) {
  totalChecks++;
  if (condition) {
    console.log(`PASS: ${label}`);
    passedChecks++;
  } else {
    console.error(`FAIL: ${label}`);
    allPassed = false;
  }
}

console.log('\n=== Link Validator Regression Tests ===\n');

// ---- Test 1: stripFencedBlocks removes links inside backtick fences ----
const backtickFence = [
  '# Test',
  '',
  'Valid [link](../README.md) here',
  '',
  '```markdown',
  '> **Read first:** [Fake broken link](NONEXISTENT.md)',
  '```',
  '',
  'Another valid [link](../SECURITY.md) here'
].join('\n');

const stripped1 = stripFencedBlocks(backtickFence);
check('Backtick fenced block is removed', !stripped1.includes('NONEXISTENT.md'));
check('Content outside backtick fence is preserved', stripped1.includes('Valid [link](../README.md)'));
check('Content after backtick fence is preserved', stripped1.includes('Another valid [link](../SECURITY.md)'));

// ---- Test 2: stripFencedBlocks removes links inside tilde fences ----
const tildeFence = [
  '# Test',
  '',
  '~~~markdown',
  '[Fake broken link](FAKE.md) inside tilde block',
  '~~~',
  '',
  'Real [link](../CHANGELOG.md) here'
].join('\n');

const stripped2 = stripFencedBlocks(tildeFence);
check('Tilde fenced block is removed', !stripped2.includes('FAKE.md'));
check('Content outside tilde fence is preserved', stripped2.includes('Real [link](../CHANGELOG.md)'));

// ---- Test 3: Regular markdown links outside fences are untouched ----
const noFence = [
  '# Test',
  'A [valid link](../README.md) and another [valid link](../SECURITY.md)'
].join('\n');

const stripped3 = stripFencedBlocks(noFence);
check('Regular links without fences are untouched', stripped3 === noFence);

// ---- Test 4: Links before a fence are preserved ----
const beforeFence = [
  '[Before](../README.md) fence',
  '',
  '```',
  '[Inside](fake.md) fence',
  '```'
].join('\n');

const stripped4 = stripFencedBlocks(beforeFence);
check('Links before fence are preserved', stripped4.includes('[Before](../README.md)'));
check('Links inside fence are removed', !stripped4.includes('[Inside](fake.md)'));

// ---- Test 5: Multiple fences are handled ----
const multiFence = [
  '```',
  '[First block](a.md)',
  '```',
  'Outside [real](../README.md)',
  '```',
  '[Second block](b.md)',
  '```'
].join('\n');

const stripped5 = stripFencedBlocks(multiFence);
check('Multiple fences are all removed', !stripped5.includes('[First block](a.md)'));
check('Multiple fences — content between preserved', stripped5.includes('Outside [real](../README.md)'));
check('Multiple fences — second block removed', !stripped5.includes('[Second block](b.md)'));

// ---- Integration test: full validator against regression fixture ----
const fixturePath = path.resolve(__dirname, 'fixtures', 'link-validator-regression.md');
const fixtureContent = fs.readFileSync(fixturePath, 'utf8');
const stripped = stripFencedBlocks(fixtureContent);
const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
const fileDir = path.dirname(fixturePath);
let match;
const foundBroken = [];

while ((match = linkRegex.exec(stripped)) !== null) {
  const link = match[2];
  if (link.startsWith('http://') || link.startsWith('https://') ||
      link.startsWith('mailto:') || link.startsWith('#')) continue;
  const resolved = path.resolve(fileDir, link);
  if (!fs.existsSync(resolved)) {
    foundBroken.push(link);
  }
}

check('Regression fixture: broken link inside fenced block is ignored (no false positive)',
  foundBroken.length === 1 && foundBroken[0] === 'definitely-does-not-exist-anywhere.md');
check('Regression fixture: valid link outside fence resolves correctly',
  foundBroken.length === 1); // only the intentional broken link

console.log(`\n=== Results: ${passedChecks}/${totalChecks} passed ===\n`);
process.exit(allPassed ? 0 : 1);
