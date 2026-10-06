/**
 * The handful of Linux commands the lab offers, re-implemented on the virtual
 * file system.  lab.ts does all the rule checking; this module only does the
 * work once a command has been approved.  Output mimics GNU coreutils (English).
 */
import { VFS, FsError, basename, dirname, isAbs, join, normpath, VNode } from './vfs';
import { blue, bold } from './ansi';

export interface Ctx {
  fs: VFS;
  cwd: string;
  width: number;
  print: (s?: string) => void;
}

const resolve = (cwd: string, p: string) => normpath(isAbs(p) ? p : join(cwd, p));

function relpath(target: string, from: string): string {
  const t = normpath(target).split('/').filter(Boolean);
  const f = normpath(from).split('/').filter(Boolean);
  let i = 0;
  while (i < t.length && i < f.length && t[i] === f[i]) i++;
  const r = [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/');
  return r || '.';
}

/** Parse GNU-style options.  Throws an Error with the tool's own message. */
function parse(cmd: string, args: string[], short: string, long: string[] = []): { flags: Set<string>; ops: string[] } {
  const flags = new Set<string>();
  const ops: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { ops.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      if (!long.includes(a.slice(2))) throw new Error(`${cmd}: unrecognized option '${a}'`);
      flags.add(a.slice(2));
    } else if (a.startsWith('-') && a.length > 1) {
      for (const ch of a.slice(1)) {
        if (!short.includes(ch)) throw new Error(`${cmd}: invalid option -- '${ch}'`);
        flags.add(ch);
      }
    } else ops.push(a);
  }
  return { flags, ops };
}

const has = (flags: Set<string>, ...names: string[]) => names.some(n => flags.has(n));

function fail(c: Ctx, msg: string): number { c.print(msg); return 1; }
const why = (e: unknown): string => (e instanceof FsError ? e.reason : 'error');

function mkdir(c: Ctx, args: string[]): number {
  let r;
  try { r = parse('mkdir', args, 'pv', ['parents', 'verbose']); } catch (e) { return fail(c, (e as Error).message); }
  const { flags, ops } = r;
  if (!ops.length) return fail(c, 'mkdir: missing operand');
  let rc = 0;
  for (const p of ops) {
    const full = resolve(c.cwd, p);
    try {
      if (has(flags, 'p', 'parents')) {
        const missing: string[] = [];
        for (let a = full; !c.fs.exists(a); a = dirname(a)) missing.push(a);
        if (c.fs.exists(full) && !c.fs.isDir(full)) throw new FsError('EEXIST');
        c.fs.mkdirp(full);
        if (has(flags, 'v', 'verbose')) {
          for (const m of missing.reverse()) c.print(`mkdir: created directory '${isAbs(p) ? m : relpath(m, c.cwd)}'`);
        }
      } else {
        c.fs.mkdir(full);
        if (has(flags, 'v', 'verbose')) c.print(`mkdir: created directory '${p}'`);
      }
    } catch (e) { rc = fail(c, `mkdir: cannot create directory '${p}': ${why(e)}`); }
  }
  return rc;
}

function touch(c: Ctx, args: string[]): number {
  let r;
  try { r = parse('touch', args, 'c', ['no-create']); } catch (e) { return fail(c, (e as Error).message); }
  const { flags, ops } = r;
  if (!ops.length) return fail(c, 'touch: missing file operand');
  let rc = 0;
  for (const p of ops) {
    const full = resolve(c.cwd, p);
    try {
      if (c.fs.exists(full)) c.fs.touch(full);
      else if (!has(flags, 'c', 'no-create')) c.fs.touch(full);
    } catch (e) { rc = fail(c, `touch: cannot touch '${p}': ${why(e)}`); }
  }
  return rc;
}

function rm(c: Ctx, args: string[]): number {
  let r;
  try { r = parse('rm', args, 'rRfdiv', ['recursive', 'force', 'dir', 'verbose']); } catch (e) { return fail(c, (e as Error).message); }
  const { flags, ops } = r;
  const force = has(flags, 'f', 'force');
  const rec = has(flags, 'r', 'R', 'recursive');
  const verbose = has(flags, 'v', 'verbose');
  if (!ops.length) return force ? 0 : fail(c, 'rm: missing operand');
  let rc = 0;
  for (const p of ops) {
    const full = resolve(c.cwd, p);
    if (!c.fs.exists(full)) {
      if (!force) rc = fail(c, `rm: cannot remove '${p}': No such file or directory`);
      continue;
    }
    try {
      if (c.fs.isDir(full)) {
        if (rec) c.fs.rmtree(full);
        else if (has(flags, 'd', 'dir')) c.fs.rmdir(full);
        else { rc = fail(c, `rm: cannot remove '${p}': Is a directory`); continue; }
      } else c.fs.removeFile(full);
      if (verbose) c.print(`removed '${p}'`);
    } catch (e) { rc = fail(c, `rm: cannot remove '${p}': ${why(e)}`); }
  }
  return rc;
}

function rmdir(c: Ctx, args: string[]): number {
  let r;
  try { r = parse('rmdir', args, 'pv', ['parents', 'verbose']); } catch (e) { return fail(c, (e as Error).message); }
  const { flags, ops } = r;
  if (!ops.length) return fail(c, 'rmdir: missing operand');
  let rc = 0;
  for (const p of ops) {
    const full = resolve(c.cwd, p);
    try {
      c.fs.rmdir(full);
      if (has(flags, 'v', 'verbose')) c.print(`rmdir: removing directory, '${p}'`);
      if (has(flags, 'p', 'parents')) {
        let parent = dirname(full);
        while (parent !== c.cwd && parent.length > 1) {
          try { c.fs.rmdir(parent); } catch { break; }
          parent = dirname(parent);
        }
      }
    } catch (e) { rc = fail(c, `rmdir: failed to remove '${p}': ${why(e)}`); }
  }
  return rc;
}

interface Pair { s: string; sfull: string; final: string }

function plan(cmd: string, ops: string[], cwd: string, fs: VFS): { pairs?: Pair[]; msg?: string } {
  if (ops.length < 2) {
    return { msg: ops.length ? `${cmd}: missing destination file operand after '${ops[0]}'` : `${cmd}: missing file operand` };
  }
  const dest = ops[ops.length - 1];
  const srcs = ops.slice(0, -1);
  const dfull = resolve(cwd, dest);
  if (srcs.length > 1 && !fs.isDir(dfull)) return { msg: `${cmd}: target '${dest}' is not a directory` };
  const pairs = srcs.map(s => {
    const sfull = resolve(cwd, s);
    return { s, sfull, final: fs.isDir(dfull) ? join(dfull, basename(sfull)) : dfull };
  });
  return { pairs };
}

const inside = (path: string, parent: string) => path === parent || path.startsWith(parent.replace(/\/+$/, '') + '/');

function cp(c: Ctx, args: string[]): number {
  let r;
  try { r = parse('cp', args, 'rRfnivpa', ['recursive', 'force', 'no-clobber', 'verbose']); } catch (e) { return fail(c, (e as Error).message); }
  const { flags, ops } = r;
  const { pairs, msg } = plan('cp', ops, c.cwd, c.fs);
  if (msg) return fail(c, msg);
  const rec = has(flags, 'r', 'R', 'a', 'recursive');
  let rc = 0;
  for (const { s, sfull, final } of pairs!) {
    if (!c.fs.exists(sfull)) { rc = fail(c, `cp: cannot stat '${s}': No such file or directory`); continue; }
    if (c.fs.isDir(sfull)) {
      if (!rec) { rc = fail(c, `cp: -r not specified; omitting directory '${s}'`); continue; }
      if (inside(final, sfull)) {
        rc = fail(c, `cp: cannot copy a directory, '${s}', into itself, '${relpath(final, c.cwd)}'`); continue;
      }
      if (c.fs.isFile(final)) { rc = fail(c, `cp: cannot overwrite non-directory '${final}' with directory '${s}'`); continue; }
    } else if (c.fs.isDir(final)) {
      rc = fail(c, `cp: cannot overwrite directory '${final}' with non-directory`); continue;
    }
    if (sfull === final) { rc = fail(c, `cp: '${s}' and '${s}' are the same file`); continue; }
    if (c.fs.exists(final) && has(flags, 'n', 'no-clobber')) continue;
    try {
      c.fs.copy(sfull, final);
      if (has(flags, 'v', 'verbose')) c.print(`'${s}' -> '${relpath(final, c.cwd)}'`);
    } catch (e) { rc = fail(c, `cp: cannot create regular file '${relpath(final, c.cwd)}': ${why(e)}`); }
  }
  return rc;
}

function mv(c: Ctx, args: string[]): number {
  let r;
  try { r = parse('mv', args, 'fnivu', ['force', 'no-clobber', 'verbose']); } catch (e) { return fail(c, (e as Error).message); }
  const { flags, ops } = r;
  const { pairs, msg } = plan('mv', ops, c.cwd, c.fs);
  if (msg) return fail(c, msg);
  let rc = 0;
  for (const { s, sfull, final } of pairs!) {
    if (!c.fs.exists(sfull)) { rc = fail(c, `mv: cannot stat '${s}': No such file or directory`); continue; }
    if (sfull === final) { rc = fail(c, `mv: '${s}' and '${s}' are the same file`); continue; }
    if (c.fs.isDir(sfull) && inside(final, sfull)) {
      rc = fail(c, `mv: cannot move '${s}' to a subdirectory of itself, '${relpath(final, c.cwd)}'`); continue;
    }
    if (c.fs.isDir(final) && !c.fs.isDir(sfull)) { rc = fail(c, `mv: cannot overwrite directory '${final}' with non-directory`); continue; }
    if (c.fs.isFile(final) && c.fs.isDir(sfull)) {
      rc = fail(c, `mv: cannot overwrite non-directory '${final}' with directory '${s}'`); continue;
    }
    if (c.fs.exists(final) && has(flags, 'n', 'no-clobber')) continue;
    try {
      if (c.fs.isDir(final) && c.fs.isDir(sfull)) {
        if (c.fs.list(final).length) { rc = fail(c, `mv: cannot overwrite '${relpath(final, c.cwd)}': Directory not empty`); continue; }
        c.fs.rmdir(final);
      }
      c.fs.move(sfull, final);
      if (has(flags, 'v', 'verbose')) c.print(`renamed '${s}' -> '${relpath(final, c.cwd)}'`);
    } catch (e) { rc = fail(c, `mv: cannot move '${s}' to '${relpath(final, c.cwd)}': ${why(e)}`); }
  }
  return rc;
}

// ---- ls ----------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const enc = new TextEncoder();

function human(n: number): string {
  for (const unit of ['', 'K', 'M', 'G']) {
    if (n < 1024) return unit === '' || n >= 10 ? `${Math.floor(n)}${unit}` : `${n.toFixed(1)}${unit}`;
    n /= 1024;
  }
  return `${Math.floor(n)}T`;
}

const sizeOf = (n: VNode) => (n.type === 'dir' ? 4096 : enc.encode(n.content).length);

function decorate(name: string, node: VNode, flags: Set<string>): string {
  const isdir = node.type === 'dir';
  let out = isdir ? blue(bold(name)) : name;
  if (has(flags, 'F') && isdir) out += '/';
  return out;
}

const plainLen = (name: string, node: VNode, flags: Set<string>) =>
  name.length + (has(flags, 'F') && node.type === 'dir' ? 1 : 0);

function longLine(name: string, node: VNode, flags: Set<string>): string[] {
  const d = new Date(node.mtime);
  const day = String(d.getDate()).padStart(2, ' ');
  const stamp = Date.now() - node.mtime > 180 * 86400000
    ? `${MONTHS[d.getMonth()]} ${day}  ${d.getFullYear()}`
    : `${MONTHS[d.getMonth()]} ${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const size = has(flags, 'h') ? human(sizeOf(node)) : String(sizeOf(node));
  const nlink = node.type === 'dir' ? 2 + [...node.children.values()].filter(x => x.type === 'dir').length : 1;
  return [node.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--', String(nlink), 'student', 'student', size, stamp,
    decorate(name, node, flags)];
}

function printLong(c: Ctx, rows: string[][]): void {
  if (!rows.length) return;
  const w = [0, 1, 2, 3, 4].map(i => Math.max(...rows.map(r => r[i].length)));
  for (const r of rows) {
    c.print(`${r[0]} ${r[1].padStart(w[1])} ${r[2].padEnd(w[2])} ${r[3].padEnd(w[3])} ${r[4].padStart(w[4])} ${r[5]} ${r[6]}`);
  }
}

const sortKey = (n: string) => n.toLowerCase().replace(/^\.+/, '');
const byName = (a: string, b: string) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0);

function printEntries(c: Ctx, dir: string, names: string[], flags: Set<string>): void {
  names = names.slice().sort(byName);
  const nodeOf = (n: string): VNode => c.fs.get(n === '.' || n === '..' ? dir : join(dir, n))!;
  if (has(flags, 'l')) { printLong(c, names.map(n => longLine(n, nodeOf(n), flags))); return; }
  if (has(flags, '1') || !names.length) { for (const n of names) c.print(decorate(n, nodeOf(n), flags)); return; }
  // column-major layout like ls on a terminal
  const lens = names.map(n => plainLen(n, nodeOf(n), flags));
  let best: { nrows: number; widths: number[] } | null = null;
  for (let ncols = names.length; ncols >= 1; ncols--) {
    const nrows = Math.ceil(names.length / ncols);
    const cols: number[][] = [];
    for (let i = 0; i < ncols; i++) {
      const col = lens.slice(i * nrows, (i + 1) * nrows);
      if (col.length) cols.push(col);
    }
    const widths = cols.map(col => Math.max(...col));
    if (widths.reduce((a, b) => a + b, 0) + 2 * (cols.length - 1) <= c.width || ncols === 1) { best = { nrows, widths }; break; }
  }
  const { nrows, widths } = best!;
  for (let r = 0; r < nrows; r++) {
    const line: string[] = [];
    for (let ci = 0; ci < widths.length; ci++) {
      const i = ci * nrows + r;
      if (i >= names.length) break;
      line.push(decorate(names[i], nodeOf(names[i]), flags) + ' '.repeat(widths[ci] - lens[i]));
    }
    c.print(line.join('  ').replace(/\s+$/, ''));
  }
}

function ls(c: Ctx, args: string[]): number {
  let r;
  try { r = parse('ls', args, 'aAlRd1Fh', ['all', 'almost-all', 'recursive', 'directory']); } catch (e) { return fail(c, (e as Error).message); }
  const { flags, ops } = r;
  for (const [long, short] of [['all', 'a'], ['almost-all', 'A'], ['recursive', 'R'], ['directory', 'd']]) {
    if (flags.has(long)) flags.add(short);
  }
  let rc = 0;
  const files: [string, string][] = [];
  const dirs: [string, string][] = [];
  for (const p of ops.length ? ops : ['.']) {
    const full = resolve(c.cwd, p);
    if (!c.fs.exists(full)) rc = fail(c, `ls: cannot access '${p}': No such file or directory`);
    else if (c.fs.isDir(full) && !has(flags, 'd')) dirs.push([p, full]);
    else files.push([p, full]);
  }
  const lower = (t: [string, string]) => t[0].toLowerCase();
  if (files.length) {
    files.sort((a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0));
    if (has(flags, 'l')) printLong(c, files.map(([p, full]) => longLine(p, c.fs.get(full)!, flags)));
    else for (const [p, full] of files) c.print(decorate(p, c.fs.get(full)!, flags));
  }
  dirs.sort((a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0));
  const heading = ops.length > 1 || has(flags, 'R');
  let first = !files.length;

  const show = (label: string, full: string) => {
    if (!first) c.print();
    first = false;
    if (heading) c.print(label + ':');
    let names = c.fs.list(full);
    if (has(flags, 'a')) names = [...names, '.', '..'];
    else if (!has(flags, 'A')) names = names.filter(n => !n.startsWith('.'));
    if (has(flags, 'l')) {
      let total = 0;
      for (const n of names) {
        if (n === '.' || n === '..') continue;
        const node = c.fs.get(join(full, n))!;
        total += node.type === 'dir' ? 4 : node.content.length ? Math.ceil(enc.encode(node.content).length / 4096) * 4 : 0;
      }
      c.print(`total ${total}`);
    }
    printEntries(c, full, names, flags);
    if (has(flags, 'R')) {
      for (const n of [...names].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))) {
        const sub = join(full, n);
        if (n !== '.' && n !== '..' && c.fs.isDir(sub)) show(label !== '.' ? label + '/' + n : './' + n, sub);
      }
    }
  };
  for (const [label, full] of dirs) show(label, full);
  return rc;
}

// ---- tree --------------------------------------------------------------------

function tree(c: Ctx, args: string[]): number {
  const opts = args.filter(a => a.startsWith('-') && a.length > 1);
  const paths = args.filter(a => !(a.startsWith('-') && a.length > 1));
  let maxDepth: number | null = null;
  if (opts.includes('-L') && paths.length) {
    const n = parseInt(paths.shift()!, 10);
    if (!Number.isNaN(n)) maxDepth = n;
  }
  const showAll = opts.some(o => o === '--all' || (!o.startsWith('--') && o.includes('a')));
  const dirsOnly = opts.some(o => !o.startsWith('--') && o.includes('d'));
  let nd = 0, nf = 0;

  const walk = (d: string, prefix: string, depth: number) => {
    if (maxDepth !== null && depth > maxDepth) return;
    let entries = c.fs.list(d).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    if (!showAll) entries = entries.filter(e => !e.startsWith('.'));
    if (dirsOnly) entries = entries.filter(e => c.fs.isDir(join(d, e)));
    entries.forEach((e, i) => {
      const last = i === entries.length - 1;
      const full = join(d, e);
      const isdir = c.fs.isDir(full);
      c.print(prefix + (last ? '└── ' : '├── ') + (isdir ? blue(e) : e));
      if (isdir) { nd++; walk(full, prefix + (last ? '    ' : '│   '), depth + 1); } else nf++;
    });
  };

  for (const p of paths.length ? paths : ['.']) {
    const full = resolve(c.cwd, p);
    if (!c.fs.isDir(full)) { c.print(`${p}  [error opening dir]`); continue; }
    c.print(blue(p));
    walk(full, '', 1);
  }
  c.print();
  c.print(`${nd} director${nd === 1 ? 'y' : 'ies'}, ${nf} file${nf === 1 ? '' : 's'}`);
  return 0;
}

export const COMMANDS: Record<string, (c: Ctx, args: string[]) => number> = {
  ls, cp, mv, rm, rmdir, mkdir, touch, tree,
};
