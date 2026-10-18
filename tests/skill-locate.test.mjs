import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findRepoRoot, locateSkillRoot } from '../dist/chat/skill-locate.js';
import { loadAgentPrompt, loadProtocolDigest } from '../dist/chat/skill-protocol.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const nestedSkillPath = path.join('skills', 'hive-mind-council', 'skills', 'hive-mind-council');
const flatSkillPath = path.join('skills', 'hive-mind-council');
const builtinSkillRoot = path.join(packageRoot, nestedSkillPath);
const agents = ['Queen', 'Scout', 'Architect', 'Forger', 'Sentinel', 'Scribe'];
const references = [
  'council-protocol.md',
  'handoff-schema.md',
  'orchestration-presets.md',
  'role-contracts.md',
  'runtime-capabilities.md',
  'safety-policy.md',
  'verification-policy.md',
];

async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-skill-locate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function assertCouncilAssets(skillRoot) {
  assert.ok(skillRoot, 'the bundled council skill must be found');
  for (const agent of agents) {
    const text = await fs.readFile(path.join(builtinSkillRoot, 'agents', `${agent}.md`), 'utf8');
    assert.equal(await loadAgentPrompt(skillRoot, agent), text.slice(0, 4000));
  }
  assert.match(await loadAgentPrompt(skillRoot, 'Queen'), /^# Queen Role — Orchestrator and Final Authority/);

  for (const reference of references) {
    const text = await fs.readFile(path.join(builtinSkillRoot, 'references', reference), 'utf8');
    assert.equal(await fs.readFile(path.join(skillRoot, 'references', reference), 'utf8'), text);
  }
  const digest = await loadProtocolDigest(skillRoot);
  assert.match(digest, /^## orchestration-presets\n# Orchestration Presets/m);
  assert.notEqual(digest, await loadProtocolDigest(null));
}

for (const name of ['@uzzy-malolos/hive', 'hive']) {
  test(`findRepoRoot recognizes ${name} from a nested directory`, async (t) => {
    const root = await makeTempDir(t);
    const cwd = path.join(root, 'workspace', 'nested');
    await fs.mkdir(cwd, { recursive: true });
    await writeFile(root, 'package.json', JSON.stringify({ name }));

    assert.equal(await findRepoRoot(cwd), root);
    assert.equal(await findRepoRoot(root), root);
  });
}

for (const [label, metadata] of [
  ['an unrelated package name', JSON.stringify({ name: 'unrelated-project' })],
  ['a package without a name', JSON.stringify({ private: true })],
  ['missing package metadata', null],
  ['corrupt package metadata', '{not json'],
]) {
  test(`findRepoRoot returns cwd for ${label}`, async (t) => {
    const root = await makeTempDir(t);
    const cwd = path.join(root, 'workspace', 'nested');
    await fs.mkdir(cwd, { recursive: true });
    if (metadata !== null) await writeFile(root, 'package.json', metadata);

    assert.equal(await findRepoRoot(cwd), cwd);
  });
}

test('findRepoRoot walks past missing and corrupt metadata to a recognized ancestor', async (t) => {
  const root = await makeTempDir(t);
  await writeFile(root, 'package.json', JSON.stringify({ name: '@uzzy-malolos/hive' }));
  const cwd = path.join(root, 'corrupt', 'missing', 'nested');
  await fs.mkdir(cwd, { recursive: true });
  await writeFile(root, path.join('corrupt', 'package.json'), '{not json');

  assert.equal(await findRepoRoot(cwd), root);
});

test('locateSkillRoot preserves repository and cwd override precedence before built-ins', async (t) => {
  const root = await makeTempDir(t);
  const cwd = path.join(root, 'workspace');
  await writeFile(root, 'package.json', JSON.stringify({ name: '@uzzy-malolos/hive' }));
  const candidates = [
    path.join(root, nestedSkillPath),
    path.join(root, flatSkillPath),
    path.join(cwd, nestedSkillPath),
    path.join(cwd, flatSkillPath),
  ];
  for (const candidate of candidates) {
    await writeFile(candidate, path.join('agents', 'Queen.md'), '# Project-local Queen\n');
  }

  for (const candidate of candidates) {
    assert.equal(await locateSkillRoot(cwd), candidate);
    await fs.rm(path.join(candidate, 'agents', 'Queen.md'));
  }
  assert.equal(await locateSkillRoot(cwd), builtinSkillRoot);
});

test('locateSkillRoot skips a directory named Queen.md and keeps looking for a readable prompt file', async (t) => {
  const cwd = await makeTempDir(t);
  await fs.mkdir(path.join(cwd, nestedSkillPath, 'agents', 'Queen.md'), { recursive: true });
  const validSkillRoot = path.join(cwd, flatSkillPath);
  await writeFile(validSkillRoot, path.join('agents', 'Queen.md'), '# Project-local Queen\n');

  assert.equal(await locateSkillRoot(cwd), validSkillRoot);
});

test('locateSkillRoot loads real bundled council assets from an unrelated unnamed project', async (t) => {
  const cwd = await makeTempDir(t);
  await writeFile(cwd, 'package.json', JSON.stringify({ private: true }));

  assert.equal(await findRepoRoot(cwd), cwd);
  const skillRoot = await locateSkillRoot(cwd);
  assert.equal(skillRoot, builtinSkillRoot);
  await assertCouncilAssets(skillRoot);
});

test('locateSkillRoot resolves installed assets from a module URL with spaces and encoded characters', async (t) => {
  const root = await makeTempDir(t);
  const installedRoot = path.join(root, 'installed package # %', 'node_modules', '@uzzy-malolos', 'hive');
  const modulePath = path.join(installedRoot, 'dist', 'chat', 'skill-locate.js');
  const installedSkillRoot = path.join(installedRoot, nestedSkillPath);
  await writeFile(installedRoot, 'package.json', JSON.stringify({ name: '@uzzy-malolos/hive', type: 'module' }));
  await fs.mkdir(path.dirname(modulePath), { recursive: true });
  await fs.copyFile(new URL('../dist/chat/skill-locate.js', import.meta.url), modulePath);
  await fs.mkdir(installedSkillRoot, { recursive: true });
  for (const directory of ['agents', 'references']) {
    await fs.cp(path.join(builtinSkillRoot, directory), path.join(installedSkillRoot, directory), { recursive: true });
  }
  await fs.copyFile(
    path.join(packageRoot, 'skills', 'hive-mind-council', 'LICENSE'),
    path.join(installedRoot, 'skills', 'hive-mind-council', 'LICENSE'),
  );
  const cwd = path.join(root, 'unrelated-project');
  await writeFile(cwd, 'package.json', JSON.stringify({ name: 'unrelated-project' }));
  const installed = await import(pathToFileURL(modulePath).href);

  const skillRoot = await installed.locateSkillRoot(cwd);
  assert.equal(skillRoot, installedSkillRoot);
  await assertCouncilAssets(skillRoot);

  await fs.rm(path.join(installedSkillRoot, 'agents', 'Queen.md'));
  assert.equal(await installed.locateSkillRoot(cwd), null, 'missing bundled assets retain the null result');
});
