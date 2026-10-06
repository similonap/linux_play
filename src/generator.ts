import { Rng, hash32, hex8 } from './rng';
import { dirname, basename } from './vfs';

export type Mode = 'create' | 'restricted' | 'inherit' | 'exists';
export type Style = 'abs' | 'rel' | null;
export type Kind = 'file' | 'dir';

export interface Target { type: Kind; mode: Mode; source: string | null; style: Style; token: string | null }
export interface Junk { type: Kind; rmdirOnly: boolean; style: Style; nonempty: boolean; child?: boolean }
export interface Spec {
  targets: Record<string, Target>;
  junk: Record<string, Junk>;
  seed: number;
  level: number;
  created: string;
}

const DIR_WORDS = ['src', 'docs', 'tests', 'config', 'assets', 'build', 'lib', 'bin',
  'data', 'scripts', 'images', 'logs', 'backup', 'reports', 'notes',
  'public', 'vendor', 'templates', 'media', 'api'];
const FILE_WORDS = ['README.md', 'main.py', 'app.js', 'index.html', 'style.css',
  'notes.txt', 'config.yaml', 'Makefile', 'todo.txt', 'report.pdf',
  'data.csv', 'setup.sh', 'LICENSE', 'utils.py', 'logo.png',
  'schema.sql', 'intro.md', 'server.js', 'test_main.py',
  'changelog.txt'];
const JUNK_DIRS = ['tmp', 'old', 'cache', 'trash', 'scratch', 'draft', 'unused', 'leftovers'];
const JUNK_FILES = ['old.log', 'debug.log', 'notes.bak', 'Untitled.txt', 'core', 'temp.txt',
  'error.txt', 'copy_of_copy.txt', 'thumbs.db', 'crash.dump'];
const STOCK_SUBDIRS = ['downloads', 'incoming', 'archive', 'from_usb', 'backup', 'attachments'];

type Range = [number, number];
interface Cfg {
  top: Range; rootFiles: Range; files: Range; subdirs: Range; subdirsDeep: Range;
  depth: number; restricted: number; exists: number; junkDirs: Range; junkFiles: Range; junkFull: number;
}

export const LEVELS: Record<number, Cfg> = {
  1: { top: [2, 3], rootFiles: [0, 1], files: [1, 2], subdirs: [0, 1], subdirsDeep: [0, 0],
       depth: 2, restricted: 0.25, exists: 0.25, junkDirs: [1, 1], junkFiles: [1, 1], junkFull: 0 },
  2: { top: [3, 4], rootFiles: [1, 1], files: [1, 3], subdirs: [0, 2], subdirsDeep: [0, 0],
       depth: 2, restricted: 0.30, exists: 0.25, junkDirs: [1, 2], junkFiles: [1, 2], junkFull: 1 },
  3: { top: [3, 4], rootFiles: [1, 2], files: [1, 3], subdirs: [1, 2], subdirsDeep: [0, 1],
       depth: 3, restricted: 0.35, exists: 0.30, junkDirs: [2, 2], junkFiles: [2, 3], junkFull: 1 },
};

export function generate(seed: number, level: number): Spec {
  const rng = new Rng(seed);
  const cfg = LEVELS[level];
  for (let i = 0; i < 500; i++) {
    const g = tryGenerate(rng, cfg);
    if (g) {
      // directories to be copied/moved carry a hidden marker file with this token,
      // so a directory made with mkdir (and then renamed) is recognised.
      for (const [rel, n] of Object.entries(g.targets)) {
        if (n.type === 'dir' && n.mode === 'restricted') n.token = hex8(hash32(`${seed}:${rel}`));
      }
      return { ...g, seed, level, created: new Date().toISOString() };
    }
  }
  throw new Error('could not generate an exercise');
}

function splitext(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i <= 0 ? [name, ''] : [name.slice(0, i), name.slice(i)];
}

function tryGenerate(rng: Rng, cfg: Cfg): { targets: Record<string, Target>; junk: Record<string, Junk> } | null {
  const nodes: [string, Kind][] = []; // DFS order, parents before children

  for (const f of rng.sample(FILE_WORDS, rng.int(...cfg.rootFiles))) nodes.push(['work/' + f, 'file']);

  const fill = (prefix: string, depth: number) => {
    for (const f of rng.sample(FILE_WORDS, rng.int(...cfg.files))) nodes.push([prefix + '/' + f, 'file']);
    if (depth < cfg.depth) {
      const [lo, hi] = depth === 1 ? cfg.subdirs : cfg.subdirsDeep;
      const used = prefix.split('/');
      const pool = DIR_WORDS.filter(w => !used.includes(w));
      for (const d of rng.sample(pool, rng.int(lo, hi))) {
        nodes.push([prefix + '/' + d, 'dir']);
        fill(prefix + '/' + d, depth + 1);
      }
    }
  };
  for (const d of rng.sample(DIR_WORDS, rng.int(...cfg.top))) {
    nodes.push(['work/' + d, 'dir']);
    fill('work/' + d, 1);
  }

  // ---- modes: create | restricted (cp/mv only) | inherit (inside restricted) | exists
  const modes = new Map<string, Mode>();
  for (const [rel] of nodes) {
    const pm = modes.get(dirname(rel));
    if (pm === 'restricted' || pm === 'inherit') { modes.set(rel, 'inherit'); continue; }
    const r = rng.next();
    if (r < cfg.restricted) modes.set(rel, 'restricted');
    else if (r < cfg.restricted + cfg.exists && (pm === undefined || pm === 'exists')) modes.set(rel, 'exists');
    else modes.set(rel, 'create');
  }

  const types = new Map(nodes);
  const rels = [...modes.keys()];
  const restricted = rels.filter(r => modes.get(r) === 'restricted');
  const creates = rels.filter(r => modes.get(r) === 'create');
  const rfiles = rels.filter(r => (modes.get(r) === 'restricted' || modes.get(r) === 'inherit') && types.get(r) === 'file');
  if (!(restricted.length >= 2 && restricted.length <= Math.max(2, nodes.length * 0.4))) return null;
  if (rfiles.length < 1 || creates.length < 3) return null;
  if (!creates.some(r => types.get(r) === 'dir') || !creates.some(r => types.get(r) === 'file')) return null;

  // ---- path-style requirements on some of the items the student creates
  const styles = new Map<string, Style>();
  const pool = creates.slice();
  rng.shuffle(pool);
  for (let i = rng.int(1, 2); i > 0; i--) if (pool.length) styles.set(pool.pop()!, 'abs');
  for (let i = rng.int(1, 2); i > 0; i--) if (pool.length) styles.set(pool.pop()!, 'rel');

  // ---- sources for restricted items (in ~/stock or misplaced inside ~/work)
  const occupied = new Set(nodes.map(([r]) => r));
  const existsDirs = ['work', ...nodes.filter(([r, t]) => t === 'dir' && modes.get(r) === 'exists').map(([r]) => r)];
  const sources = new Map<string, string>();

  const variant = (name: string, typ: Kind): string => {
    if (typ === 'dir') return rng.choice([name + '_old', 'old-' + name, name + '2', name + '_backup']);
    const [stem, ext] = splitext(name);
    return rng.choice(['old_' + name, stem + '_v1' + ext, stem + '-copy' + ext, name + '.orig']);
  };

  for (const [rel, typ] of nodes) {
    const mode = modes.get(rel);
    if (mode === 'inherit') { sources.set(rel, sources.get(dirname(rel)) + '/' + basename(rel)); continue; }
    if (mode !== 'restricted') continue;
    const name = basename(rel);
    let src: string | null = null;
    for (let i = 0; i < 20; i++) {
      const srcName = rng.next() < 0.5 ? variant(name, typ) : name;
      const parent = rng.next() < 0.7
        ? rng.choice(['stock', 'stock', 'stock/' + rng.choice(STOCK_SUBDIRS)])
        : rng.choice(existsDirs);
      const cand = parent + '/' + srcName;
      if (!occupied.has(cand) && ![...sources.values()].includes(cand)) { src = cand; break; }
    }
    if (src === null) return null;
    sources.set(rel, src);
    occupied.add(src);
  }

  // ---- junk that has to be removed
  const junk: Record<string, Junk> = {};
  const taken = new Set(occupied);

  const place = (names: string[]): string | null => {
    for (let i = 0; i < 20; i++) {
      const cand = rng.choice(existsDirs) + '/' + rng.choice(names);
      if (!taken.has(cand) && !(dirname(cand) in junk)) { taken.add(cand); return cand; }
    }
    return null;
  };

  const nJunkDirs = rng.int(...cfg.junkDirs);
  for (let i = 0; i < nJunkDirs; i++) {
    const p = place(JUNK_DIRS);
    if (p) junk[p] = { type: 'dir', rmdirOnly: i === 0 || rng.next() < 0.5, style: null, nonempty: false };
  }
  const nJunkFiles = rng.int(...cfg.junkFiles);
  for (let i = 0; i < nJunkFiles; i++) {
    const p = place(JUNK_FILES);
    if (p) junk[p] = { type: 'file', rmdirOnly: false, style: null, nonempty: false };
  }
  for (let i = 0; i < cfg.junkFull; i++) {
    const p = place(JUNK_DIRS);
    if (p) {
      junk[p] = { type: 'dir', rmdirOnly: false, style: null, nonempty: true };
      for (const f of rng.sample([...JUNK_FILES, ...FILE_WORDS], rng.int(1, 3))) {
        junk[p + '/' + f] = { type: 'file', rmdirOnly: false, style: null, nonempty: false, child: true };
      }
    }
  }
  const junkVals = Object.values(junk);
  if (!junkVals.length || !junkVals.some(j => j.rmdirOnly)) return null;
  if (rng.next() < 0.5) {
    const cands = Object.keys(junk).filter(r => !junk[r].child);
    junk[rng.choice(cands)].style = rng.choice<Style>(['abs', 'rel']);
  }

  const targets: Record<string, Target> = {};
  for (const [rel, typ] of nodes) {
    const mode = modes.get(rel)!;
    const token = (mode === 'restricted' || mode === 'inherit') && typ === 'file' ? hex8(rng.bits32()) : null;
    targets[rel] = { type: typ, mode, source: sources.get(rel) ?? null, style: styles.get(rel) ?? null, token };
  }
  return { targets, junk };
}
