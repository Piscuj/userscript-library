// Imports a userscript build into scripts/<id>/script.user.js, pointed at this library.
// Usage: node tools/retarget.mjs <id> <source.user.js> [--version 1.2.3]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { retarget } from './retarget-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [id, source, flag, version] = process.argv.slice(2);
if (!id || !source || (flag && flag !== '--version') || (flag && !version)) {
  console.error('Usage: node tools/retarget.mjs <id> <source.user.js> [--version 1.2.3]');
  process.exit(2);
}
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'));
const result = retarget(fs.readFileSync(source, 'utf8'), catalog, id, { version });
const target = path.join(root, 'scripts', id, 'script.user.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, result.code);
console.log(`Wrote ${path.relative(root, target)} (v${result.from}${result.to !== result.from ? ' -> v' + result.to : ''}).`);
console.log('Next: add release notes for v' + result.to + ' to scripts/' + id + '/changes.json, then npm test.');
