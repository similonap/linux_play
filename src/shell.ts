import { VFS, isAbs, join, normpath } from './vfs';
import { tr } from './i18n';

/** Split a command line into words, honouring '...' "..." and backslashes (like shlex.split). */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (has) { out.push(cur); cur = ''; has = false; }
      i++;
    } else if (ch === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) throw new Error(tr('No closing quotation', 'Afsluitend aanhalingsteken ontbreekt'));
      cur += line.slice(i + 1, j); has = true; i = j + 1;
    } else if (ch === '"') {
      i++;
      for (;;) {
        if (i >= line.length) throw new Error(tr('No closing quotation', 'Afsluitend aanhalingsteken ontbreekt'));
        const d = line[i];
        if (d === '"') { i++; break; }
        if (d === '\\' && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1])) { cur += line[i + 1]; i += 2; }
        else { cur += d; i++; }
      }
      has = true;
    } else if (ch === '\\') {
      if (i + 1 >= line.length) throw new Error(tr('No escaped character', 'Geen teken na backslash'));
      cur += line[i + 1]; has = true; i += 2;
    } else { cur += ch; has = true; i++; }
  }
  if (has) out.push(cur);
  return out;
}

function segmentRegex(seg: string): RegExp {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      const j = seg.indexOf(']', i + 2);
      if (j < 0) { re += '\\['; continue; }
      let body = seg.slice(i + 1, j);
      if (body[0] === '!') body = '^' + body.slice(1);
      re += '[' + body.replace(/\\/g, '\\\\') + ']';
      i = j;
    } else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Expand * ? [..] against the virtual file system; no match returns the pattern itself. */
export function expandGlob(fs: VFS, cwd: string, pattern: string): string[] {
  if (!/[*?[]/.test(pattern)) return [pattern];
  const trailing = pattern.endsWith('/');
  const segs = pattern.split('/').filter((s, i) => s !== '' || i === 0);
  let results: string[] = [isAbs(pattern) ? '/' : ''];
  for (const seg of segs) {
    if (seg === '') continue;
    const next: string[] = [];
    for (const prefix of results) {
      const dirPath = prefix === '' ? cwd : isAbs(prefix) ? normpath(prefix) : normpath(join(cwd, prefix));
      const sep = prefix === '' || prefix.endsWith('/') ? '' : '/';
      if (!/[*?[]/.test(seg)) {
        const cand = prefix + sep + seg;
        if (fs.exists(join(dirPath, seg))) next.push(cand);
        continue;
      }
      if (!fs.isDir(dirPath)) continue;
      const re = segmentRegex(seg);
      for (const name of fs.list(dirPath).sort()) {
        if (name.startsWith('.') && !seg.startsWith('.')) continue;
        if (re.test(name)) next.push(prefix + sep + name);
      }
    }
    results = next;
  }
  if (trailing) results = results.filter(r => fs.isDir(isAbs(r) ? r : join(cwd, r))).map(r => r + '/');
  results = results.filter(r => r !== '').sort();
  return results.length ? results : [pattern];
}
