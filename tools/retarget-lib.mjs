// Points a userscript build at this library: update/download URLs, the
// library-page @match, and the bundled status reporter's origin and path.
// Every rewrite must match exactly once (or already be applied), so a changed
// source build fails loudly instead of shipping half-retargeted code.

const OLD_ORIGIN = 'https://userscript-library.piscuj.chatgpt.site';
const OLD_LIBRARY_MATCH = OLD_ORIGIN + '/control-centre/*';
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEADER_END = '// ==/UserScript==';

export function libraryUrls({ origin, basePath }, id) {
  const root = origin + basePath;
  return {
    root,
    match: root + '*',
    downloadURL: root + 'scripts/' + id + '/script.user.js',
    updateURL: root + 'scripts/' + id + '/script.meta.js',
  };
}

export function splitHeader(code) {
  const start = code.indexOf('// ==UserScript==');
  const end = code.indexOf(HEADER_END);
  if (start !== 0 || end < 0) throw Error('Missing or misplaced ==UserScript== header');
  const headerEnd = end + HEADER_END.length;
  return { header: code.slice(0, headerEnd), body: code.slice(headerEnd) };
}

export function readTag(header, name) {
  return new RegExp('^// @' + name + '\\s+(.+)$', 'm').exec(header)?.[1].trim();
}

function setTag(header, name, value) {
  const pattern = new RegExp('^(// @' + name + '\\s+).+$', 'm');
  if (pattern.test(header)) return header.replace(pattern, (_, prefix) => prefix + value);
  return header.replace(HEADER_END, '// @' + name.padEnd(12) + ' ' + value + '\n' + HEADER_END);
}

function replaceOnce(text, pattern, replacement, label, appliedMarker) {
  if (appliedMarker && text.includes(appliedMarker)) return text;
  const matches = text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'));
  if (!matches || matches.length !== 1) throw Error(label + ': expected exactly one match, found ' + (matches?.length ?? 0));
  return text.replace(pattern, replacement);
}

// Bundled reporter (control-reporter.js) rewrites. Only applied when present.
function retargetReporter(body, { origin, basePath }) {
  if (!body.includes('function createControlReporter(')) return body;
  let out = body;
  out = replaceOnce(out, /const ORIGIN = '[^']*';/, "const ORIGIN = '" + origin + "';", 'reporter ORIGIN');
  out = replaceOnce(out, /const PATH = '[^']*';/, "const PATH = '" + basePath + "';", 'reporter PATH');
  // Update all: open only the scripts the page asks for (validated ids), under
  // this library's path, instead of a fixed list at the site root.
  const updatesLoop = "for(const id of (Array.isArray(req.ids)?req.ids:[]).filter(id=>typeof id==='string'&&" + ID_PATTERN.toString() + ".test(id)).slice(0,20))await env.GM.openInTab(ORIGIN+PATH+'scripts/'+id+'/script.user.js'";
  out = replaceOnce(
    out,
    /for\(const id of \[[^\]]*\]\)await env\.GM\.openInTab\(ORIGIN\+'\/scripts\/'\+id\+'\/script\.user\.js'/,
    () => updatesLoop,
    'reporter Update all loop',
    updatesLoop,
  );
  return out;
}

// Replaces a script's own version literals in the body (reporter config,
// VERSION constants, visible "v1.2.3" labels) when bumping the version.
function bumpBodyVersion(body, from, to) {
  const escaped = from.replace(/\./g, '\\.');
  const patterns = [
    new RegExp('("version":")' + escaped + '(")', 'g'),
    new RegExp("(VERSION\\s*=\\s*')" + escaped + "(')", 'g'),
    new RegExp('(VERSION\\s*=\\s*")' + escaped + '(")', 'g'),
    new RegExp('(>v)' + escaped + '(<)', 'g'),
  ];
  return patterns.reduce((text, pattern) => text.replace(pattern, '$1' + to + '$2'), body);
}

export function retarget(code, library, id, { version } = {}) {
  if (!ID_PATTERN.test(id)) throw Error('Invalid script id: ' + id);
  const urls = libraryUrls(library, id);
  let { header, body } = splitHeader(code.replace(/\r\n/g, '\n'));
  const previous = readTag(header, 'version');
  if (!previous) throw Error('Missing @version');

  header = setTag(header, 'updateURL', urls.updateURL);
  header = setTag(header, 'downloadURL', urls.downloadURL);
  const hasLibraryMatch = new RegExp('^// @match\\s+' + urls.match.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '$', 'm');
  if (header.includes(OLD_LIBRARY_MATCH)) header = header.split(OLD_LIBRARY_MATCH).join(urls.match);
  else if (!hasLibraryMatch.test(header)) header = header.replace(HEADER_END, '// @match        ' + urls.match + '\n' + HEADER_END);

  body = retargetReporter(body, library);
  if (version && version !== previous) {
    header = setTag(header, 'version', version);
    body = bumpBodyVersion(body, previous, version);
  }
  const result = header + body;
  if (result.includes('piscuj.chatgpt.site')) throw Error('Old library host still referenced after retarget');
  return { code: result, from: previous, to: readTag(header, 'version') };
}
