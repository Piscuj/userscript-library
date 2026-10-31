import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { retarget, readTag, splitHeader } from '../tools/retarget-lib.mjs';
import { buildLibrary } from '../build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'));
const library = { origin: catalog.origin, basePath: catalog.basePath };

const OLD = 'https://userscript-library.piscuj.chatgpt.site';
const reporterBody = `
function createControlReporter(config, env) {
  const ORIGIN = '${OLD}';
  const PATH = '/control-centre/';
  if(req.action==='updates'&&env.GM?.openInTab){
    for(const id of ['a','b'])await env.GM.openInTab(ORIGIN+'/scripts/'+id+'/script.user.js',{active:false,insert:true});
  }
}
const cc=createControlReporter({"id":"x","version":"1.0.0"});
const VERSION = '1.0.0';
`;
const oldBuild = `// ==UserScript==
// @name         Example
// @namespace    test.example
// @version      1.0.0
// @updateURL    ${OLD}/scripts/x/script.meta.js
// @downloadURL  ${OLD}/scripts/x/script.user.js
// @match        https://intervals.icu/*
// @match        ${OLD}/control-centre/*
// ==/UserScript==
${reporterBody}`;

test('retarget rewrites header URLs, library match and reporter host', () => {
  const { code } = retarget(oldBuild, library, 'x');
  const { header } = splitHeader(code);
  assert.equal(readTag(header, 'downloadURL'), 'https://piscuj.github.io/userscript-library/scripts/x/script.user.js');
  assert.ok(header.includes('// @match        https://piscuj.github.io/userscript-library/*'));
  assert.ok(header.includes('// @match        https://intervals.icu/*'), 'other matches are kept');
  assert.ok(code.includes("const ORIGIN = 'https://piscuj.github.io';"));
  assert.ok(code.includes("const PATH = '/userscript-library/';"));
  assert.ok(code.includes("ORIGIN+PATH+'scripts/'+id+'/script.user.js'"));
  assert.ok(!code.includes('piscuj.chatgpt.site'));
});

test('retarget is idempotent', () => {
  const once = retarget(oldBuild, library, 'x').code;
  assert.equal(retarget(once, library, 'x').code, once);
});

test('version bump updates the header and the script’s own version literals', () => {
  const { code, from, to } = retarget(oldBuild, library, 'x', { version: '1.0.1' });
  assert.equal(from, '1.0.0');
  assert.equal(to, '1.0.1');
  assert.ok(code.includes('"version":"1.0.1"'));
  assert.ok(code.includes("const VERSION = '1.0.1';"));
  assert.ok(!code.includes('1.0.0'));
});

test('retarget fails loudly when the reporter shape changed', () => {
  assert.throws(() => retarget(oldBuild.replace("const PATH = '/control-centre/';", ''), library, 'x'), /reporter PATH/);
  assert.throws(() => retarget(oldBuild.replace("for(const id of ['a','b'])", 'for(const id of list)'), library, 'x'), /Update all loop/);
});

test('retarget adds a library match to scripts without a reporter match', () => {
  const plain = oldBuild.replace(`// @match        ${OLD}/control-centre/*\n`, '').replace(reporterBody, '\nvoid 0;\n');
  const { code } = retarget(plain, library, 'x');
  assert.ok(code.includes('// @match        https://piscuj.github.io/userscript-library/*'));
});

test('build publishes every catalog script with matching metadata and hashes', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'library-build-'));
  try {
    const entries = buildLibrary(root, out);
    assert.equal(entries.length, catalog.scripts.length);
    assert.ok(!entries.some(e => e.id === 'intervals-weight'), 'Weight is retired');
    for (const entry of entries) {
      const dir = path.join(out, 'scripts', entry.id);
      const code = fs.readFileSync(path.join(dir, 'script.user.js'), 'utf8');
      const meta = fs.readFileSync(path.join(dir, 'script.meta.js'), 'utf8');
      const release = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
      assert.ok(code.startsWith(meta.trimEnd()), 'meta file is the script header');
      assert.equal(readTag(meta, 'version'), entry.version);
      assert.equal(release.sha256, crypto.createHash('sha256').update(code).digest('hex'));
      assert.ok(release.changes.length > 0);
      assert.ok(fs.existsSync(path.join(dir, 'index.html')));
      assert.ok(fs.existsSync(path.join(dir, 'license.txt')));
    }
    const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(!/<script>(?!<\/script>)/.test(index), 'no inline executable scripts (CSP)');
    for (const entry of entries) assert.ok(index.includes(`data-script="${entry.id}"`));
    assert.ok(fs.existsSync(path.join(out, '.nojekyll')));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('build rejects a version without release notes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-src-'));
  try {
    fs.cpSync(root, temp, { recursive: true, filter: src => !/[\\/](dist|node_modules|\.git|original)([\\/]|$)/.test(src) });
    const file = path.join(temp, 'scripts', catalog.scripts[0].id, 'script.user.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(\/\/ @version\s+)\S+/, '$199.0.0'));
    assert.throws(() => buildLibrary(temp, path.join(temp, 'dist')), /release notes for v99\.0\.0/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
