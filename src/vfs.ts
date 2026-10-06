/** A tiny in-memory POSIX-like file system (directories and files only). */

export interface VFile { type: 'file'; content: string; mtime: number }
export interface VDir { type: 'dir'; children: Map<string, VNode>; mtime: number }
export type VNode = VFile | VDir;

export type FsCode = 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY';

export class FsError extends Error {
  constructor(public code: FsCode) { super(code); }
  /** The message GNU tools print after the colon. */
  get reason(): string {
    return {
      ENOENT: 'No such file or directory', EEXIST: 'File exists', ENOTDIR: 'Not a directory',
      EISDIR: 'Is a directory', ENOTEMPTY: 'Directory not empty',
    }[this.code];
  }
}

/** Like Python's os.path.normpath / posixpath.normpath. */
export function normpath(p: string): string {
  if (p === '') return '.';
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(part);
  }
  const s = out.join('/');
  return abs ? '/' + s : s || '.';
}

export const isAbs = (p: string) => p.startsWith('/');
export const join = (a: string, b: string) => (isAbs(b) ? b : a.replace(/\/+$/, '') + '/' + b);
export const dirname = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : i === 0 ? '/' : p.slice(0, i);
};
export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export class VFS {
  root: VDir = { type: 'dir', children: new Map(), mtime: Date.now() };

  private parts(path: string): string[] {
    return normpath(path).split('/').filter(Boolean);
  }

  get(path: string): VNode | undefined {
    let n: VNode = this.root;
    for (const p of this.parts(path)) {
      if (n.type !== 'dir') return undefined;
      const c = n.children.get(p);
      if (!c) return undefined;
      n = c;
    }
    return n;
  }

  exists(path: string): boolean { return this.get(path) !== undefined; }
  isDir(path: string): boolean { return this.get(path)?.type === 'dir'; }
  isFile(path: string): boolean { return this.get(path)?.type === 'file'; }

  private parentDir(path: string): VDir {
    const p = this.get(dirname(normpath(path)));
    if (!p) throw new FsError('ENOENT');
    if (p.type !== 'dir') throw new FsError('ENOTDIR');
    return p;
  }

  mkdir(path: string): void {
    const parent = this.parentDir(path);
    const name = basename(normpath(path));
    if (parent.children.has(name)) throw new FsError('EEXIST');
    parent.children.set(name, { type: 'dir', children: new Map(), mtime: Date.now() });
    parent.mtime = Date.now();
  }

  mkdirp(path: string): void {
    let cur = '';
    for (const p of this.parts(path)) {
      cur += '/' + p;
      const n = this.get(cur);
      if (!n) this.mkdir(cur);
      else if (n.type !== 'dir') throw new FsError(cur === normpath(path) ? 'EEXIST' : 'ENOTDIR');
    }
  }

  writeFile(path: string, content: string): void {
    const parent = this.parentDir(path);
    const name = basename(normpath(path));
    const ex = parent.children.get(name);
    if (ex?.type === 'dir') throw new FsError('EISDIR');
    parent.children.set(name, { type: 'file', content, mtime: Date.now() });
    parent.mtime = Date.now();
  }

  touch(path: string): void {
    const n = this.get(path);
    if (n) n.mtime = Date.now();
    else this.writeFile(path, '');
  }

  removeFile(path: string): void {
    const n = this.get(path);
    if (!n) throw new FsError('ENOENT');
    if (n.type === 'dir') throw new FsError('EISDIR');
    this.detach(path);
  }

  rmdir(path: string): void {
    const n = this.get(path);
    if (!n) throw new FsError('ENOENT');
    if (n.type !== 'dir') throw new FsError('ENOTDIR');
    if (n.children.size) throw new FsError('ENOTEMPTY');
    this.detach(path);
  }

  rmtree(path: string): void {
    if (!this.exists(path)) throw new FsError('ENOENT');
    this.detach(path);
  }

  private detach(path: string): void {
    const parent = this.parentDir(path);
    parent.children.delete(basename(normpath(path)));
    parent.mtime = Date.now();
  }

  /** Move a node; an existing destination (file, or empty dir) is replaced. */
  move(src: string, dst: string): void {
    const n = this.get(src);
    if (!n) throw new FsError('ENOENT');
    const parent = this.parentDir(dst);
    this.detach(src);
    parent.children.set(basename(normpath(dst)), n);
    parent.mtime = Date.now();
  }

  /** Deep copy; an existing destination directory is merged into, files are overwritten. */
  copy(src: string, dst: string): void {
    const n = this.get(src);
    if (!n) throw new FsError('ENOENT');
    const parent = this.parentDir(dst);
    const name = basename(normpath(dst));
    const ex = parent.children.get(name);
    if (n.type === 'dir' && ex?.type === 'dir') {
      for (const [k] of n.children) this.copy(src + '/' + k, dst + '/' + k);
      return;
    }
    parent.children.set(name, clone(n));
    parent.mtime = Date.now();
  }

  list(path: string): string[] {
    const n = this.get(path);
    if (!n) throw new FsError('ENOENT');
    if (n.type !== 'dir') throw new FsError('ENOTDIR');
    return [...n.children.keys()];
  }

  /** Every path below `path` (not `path` itself), depth-first. */
  descendants(path: string): string[] {
    const out: string[] = [];
    const base = normpath(path);
    const walk = (p: string, n: VNode) => {
      if (n.type !== 'dir') return;
      for (const [k, c] of n.children) {
        const full = p === '/' ? '/' + k : p + '/' + k;
        out.push(full);
        walk(full, c);
      }
    };
    const n = this.get(base);
    if (n) walk(base, n);
    return out;
  }

  toJSON(): unknown { return dump(this.root); }

  static fromJSON(data: unknown): VFS {
    const v = new VFS();
    v.root = load(data) as VDir;
    if (v.root.type !== 'dir') throw new Error('bad fs');
    return v;
  }
}

function clone(n: VNode): VNode {
  if (n.type === 'file') return { ...n };
  const d: VDir = { type: 'dir', children: new Map(), mtime: n.mtime };
  for (const [k, c] of n.children) d.children.set(k, clone(c));
  return d;
}

interface Dumped { t: 'd' | 'f'; m: number; s?: string; c?: Record<string, Dumped> }

function dump(n: VNode): Dumped {
  if (n.type === 'file') return { t: 'f', m: n.mtime, s: n.content };
  const c: Record<string, Dumped> = {};
  for (const [k, v] of n.children) c[k] = dump(v);
  return { t: 'd', m: n.mtime, c };
}

function load(d: unknown): VNode {
  const x = d as Dumped;
  if (x.t === 'f') return { type: 'file', content: String(x.s ?? ''), mtime: x.m };
  const dir: VDir = { type: 'dir', children: new Map(), mtime: x.m };
  for (const [k, v] of Object.entries(x.c ?? {})) dir.children.set(k, load(v));
  return dir;
}
