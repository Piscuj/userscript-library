// Validates every script release and writes the static site to dist/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { libraryUrls, readTag, splitHeader } from './tools/retarget-lib.mjs';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+(?:\.\d+)*$/;
const SITE_FILES = ['styles.css', 'model.js', 'app.js'];

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page({ title, assets, body, scripts = [], data }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
<meta name="theme-color" content="#f6f6f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121519" media="(prefers-color-scheme: dark)">
<title>${escape(title)}</title>
<link rel="stylesheet" href="${assets}styles.css">
${data ? `<script type="application/json" id="catalog-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>\n` : ''}${scripts.map(src => `<script src="${assets}${src}" defer></script>`).join('\n')}
</head>
<body>
<div class="shell">
${body}
</div>
</body>
</html>
`;
}

function tagList(tags) {
  return '<ul class="tags" aria-label="Works with">' + tags.map(tag => `<li translate="no">${escape(tag)}</li>`).join('') + '</ul>';
}

function indexBody(entries) {
  const rows = entries.map(item => `<li class="row" data-script="${item.id}" data-state="checking">
  <div class="row-main">
    <h2 class="row-title"><a href="scripts/${item.id}/">${escape(item.title)}</a></h2>
    <p class="row-summary">${escape(item.summary)}</p>
    ${tagList(item.tags)}
  </div>
  <div class="row-status">
    <span class="pill" data-role="pill">Checking…</span>
    <span class="versions" data-role="versions">v${escape(item.version)}</span>
  </div>
  <div class="row-action">
    <a class="button" data-role="action" href="scripts/${item.id}/script.user.js" target="_blank" rel="noopener" hidden>Install</a>
  </div>
</li>`).join('\n');
  return `<header class="top">
  <div>
    <h1>Script Library</h1>
    <p class="summary" id="summary" role="status" aria-live="polite">Checking installed versions…</p>
  </div>
  <div class="toolbar">
    <button class="button button-primary" id="update-all" type="button" hidden>Update All</button>
    <button class="button" id="recheck" type="button">Check Again</button>
  </div>
</header>
<p class="notice" id="notice" role="status" aria-live="polite" hidden></p>
<main>
<ul class="rows">
${rows}
</ul>
<p class="hint" id="hint" hidden>Not detected means the script isn’t installed or enabled in Tampermonkey here, or it still updates from the old library. Installing from this page replaces the existing copy and keeps its settings.</p>
</main>
<noscript><p class="hint">JavaScript is off, so installed versions can’t be checked. Use a script’s page to install it.</p></noscript>`;
}

function detailBody(item, changes) {
  const usage = item.instructions?.length
    ? '<h2>How to Use</h2><ol>' + item.instructions.map(line => `<li>${escape(line)}</li>`).join('') + '</ol>'
    : '';
  const history = changes.slice(0, 3).map(([version, notes]) =>
    `<h3>v${escape(version)}</h3><ul>${notes.map(note => `<li>${escape(note)}</li>`).join('')}</ul>`).join('');
  return `<main class="detail">
<p><a class="back" href="../../">← All scripts</a></p>
<h1>${escape(item.title)}</h1>
<p class="lead">${escape(item.summary)}</p>
${tagList(item.tags)}
<div class="detail-actions">
  <a class="button button-primary" href="script.user.js" target="_blank" rel="noopener">Install or Update</a>
  <span class="versions">v${escape(item.version)}</span>
</div>
${usage}
<h2>What’s New</h2>
${history}
<p class="small"><a href="license.txt">License</a> · <a href="release.json">Release information</a></p>
</main>`;
}

export function buildLibrary(root = path.dirname(fileURLToPath(import.meta.url)), out = path.join(root, 'dist')) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'));
  const origin = new URL(catalog.origin);
  if (origin.protocol !== 'https:' || origin.origin !== catalog.origin) throw Error('catalog.origin must be a bare https origin');
  if (!/^\/(?:[a-z0-9-]+\/)*$/.test(catalog.basePath)) throw Error('catalog.basePath must start and end with /');

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const ids = new Set(), identities = new Set(), entries = [];

  for (const item of catalog.scripts) {
    if (!ID_PATTERN.test(item.id) || ids.has(item.id)) throw Error('Invalid or duplicate catalog id: ' + item.id);
    if (!item.title || !item.summary || !Array.isArray(item.tags)) throw Error('Catalog entry needs title, summary and tags: ' + item.id);
    ids.add(item.id);

    const source = path.join(root, 'scripts', item.id);
    const code = fs.readFileSync(path.join(source, 'script.user.js'), 'utf8');
    const fail = message => { throw Error(item.id + ': ' + message); };
    if (code.includes('\r')) fail('script.user.js must use LF line endings');
    const { header } = splitHeader(code);
    const name = readTag(header, 'name'), namespace = readTag(header, 'namespace'), version = readTag(header, 'version');
    if (!name || !namespace) fail('missing @name or @namespace');
    if (identities.has(namespace + '|' + name)) fail('@name/@namespace collides with another script');
    identities.add(namespace + '|' + name);
    if (!VERSION_PATTERN.test(version ?? '')) fail('invalid @version ' + version);
    const urls = libraryUrls(catalog, item.id);
    if (readTag(header, 'downloadURL') !== urls.downloadURL) fail('@downloadURL must be ' + urls.downloadURL);
    if (readTag(header, 'updateURL') !== urls.updateURL) fail('@updateURL must be ' + urls.updateURL);
    if (code.includes('piscuj.chatgpt.site')) fail('still references the old library host');
    if (code.includes('function createControlReporter(') && !new RegExp('^// @match\\s+' + urls.match.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '$', 'm').test(header)) {
      fail('reporter present but no @match for ' + urls.match + ', so the library cannot detect it');
    }
    try { new vm.Script(code, { filename: item.id + '.user.js' }); } catch (error) { fail('syntax error: ' + error.message); }

    const changeLog = JSON.parse(fs.readFileSync(path.join(source, 'changes.json'), 'utf8'));
    if (!Array.isArray(changeLog[version]) || !changeLog[version].length) fail('changes.json needs release notes for v' + version);
    const changes = Object.entries(changeLog).sort(([a], [b]) => {
      const x = a.split('.').map(Number), y = b.split('.').map(Number);
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
      return 0;
    });
    if (changes[0][0] !== version) fail('changes.json has notes for a version newer than @version');
    if (!fs.existsSync(path.join(source, 'license.txt'))) fail('missing license.txt');

    const target = path.join(out, 'scripts', item.id);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'script.user.js'), code);
    // Tampermonkey compares @version from this header-only file to decide whether to update.
    fs.writeFileSync(path.join(target, 'script.meta.js'), header + '\n');
    fs.copyFileSync(path.join(source, 'license.txt'), path.join(target, 'license.txt'));
    const sha256 = crypto.createHash('sha256').update(code).digest('hex');
    fs.writeFileSync(path.join(target, 'release.json'), JSON.stringify({ version, sha256, downloadURL: urls.downloadURL, updateURL: urls.updateURL, changes: changeLog[version] }, null, 2) + '\n');

    const entry = { id: item.id, title: item.title, summary: item.summary, tags: item.tags, version, downloadURL: urls.downloadURL, updateURL: urls.updateURL, sha256 };
    entries.push(entry);
    fs.writeFileSync(path.join(target, 'index.html'), page({ title: item.title + ' · Script Library', assets: '../../', body: detailBody({ ...item, version }, changes) }));
  }

  const data = { scripts: entries.map(({ id, version }) => ({ id, version })) };
  fs.writeFileSync(path.join(out, 'index.html'), page({ title: catalog.title, assets: '', body: indexBody(entries), scripts: ['model.js', 'app.js'], data }));
  fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify({ title: catalog.title, scripts: entries }, null, 2) + '\n');
  for (const file of SITE_FILES) fs.copyFileSync(path.join(root, 'site', file), path.join(out, file));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return entries;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = buildLibrary();
  console.log('Built ' + entries.length + ' scripts: ' + entries.map(e => e.id + ' v' + e.version).join(', '));
}
