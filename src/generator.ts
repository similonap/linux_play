import { Rng, hash32, hex8 } from './rng';
import { dirname, basename } from './vfs';

export type Mode = 'create' | 'restricted' | 'inherit' | 'exists';
/** abs: path starts with / or ~ | rel: any other path | home: path starts with ~ | dot: destination is `.` */
export type Style = 'abs' | 'rel' | 'home' | 'dot' | null;
export type Kind = 'file' | 'dir';

export interface Target {
  type: Kind; mode: Mode; source: string | null; style: Style; token: string | null;
  /** part of a wildcard group: must be copied/moved through a * or ? pattern */
  glob?: boolean;
}
/** A set of files in ~/stock that has to be moved into `dir` with one wildcard pattern. */
export interface Group {
  kind: 'prefix' | 'suffix' | 'single';
  dir: string;       // target directory, e.g. work/images
  parent: string;    // where the files live, e.g. stock/downloads
  files: string[];
  decoys: string[];  // look-alikes next to them that must NOT be moved
  pattern: string;   // a pattern that selects exactly `files` (used by the tests)
  parts: string[];   // pieces of the description shown to the student
}
export interface Junk { type: Kind; rmdirOnly: boolean; style: Style; nonempty: boolean; child?: boolean }
export type Difficulty = 1 | 2 | 3;

/** What an exercise may practise.  mkdir/touch/cd/ls/tree are always part of it. */
export interface Features {
  copyMove: boolean;  // items that must be brought over with cp/mv (★)
  abs: boolean;       // absolute paths
  rel: boolean;       // relative paths (including ..)
  home: boolean;      // paths that start with ~
  dot: boolean;       // `.` as destination (needs copyMove)
  star: boolean;      // wildcard *
  question: boolean;  // wildcard ?
  remove: boolean;    // things to delete (rm, rm -r)
  rmdirOnly: boolean; // empty directories that must go with rmdir (needs remove)
}
export const FEATURE_KEYS = ['copyMove', 'abs', 'rel', 'home', 'dot', 'star', 'question', 'remove', 'rmdirOnly'] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];

/** Difficulty = size of the exercise + which features are switched on by default. */
export interface Options { difficulty: Difficulty; features: Features }

const ALL_OFF: Features = { copyMove: false, abs: false, rel: false, home: false, dot: false,
  star: false, question: false, remove: false, rmdirOnly: false };
const EASY: Features = { ...ALL_OFF, copyMove: true, abs: true, rel: true, remove: true, rmdirOnly: true };
export const PRESETS: Record<Difficulty, Features> = {
  1: EASY,
  2: { ...EASY, home: true, star: true },
  3: { ...EASY, home: true, star: true, question: true, dot: true },
};

export const presetOptions = (difficulty: Difficulty): Options => ({ difficulty, features: { ...PRESETS[difficulty] } });

/** Fix combinations that make no sense (. needs cp/mv, the rmdir rule needs deleting). */
export function normalizeFeatures(f: Features): Features {
  const n = { ...ALL_OFF, ...f };
  if (!n.copyMove) n.dot = false;
  if (!n.remove) n.rmdirOnly = false;
  return n;
}

/** True when the features differ from the preset of the chosen difficulty. */
export const isCustom = (o: Options): boolean => FEATURE_KEYS.some(k => o.features[k] !== PRESETS[o.difficulty][k]);

export const sameOptions = (a: Options, b: Options): boolean =>
  a.difficulty === b.difficulty && FEATURE_KEYS.every(k => a.features[k] === b.features[k]);

export interface Spec {
  targets: Record<string, Target>;
  junk: Record<string, Junk>;
  groups?: Group[];
  options?: Options;  // missing in exercises saved by older versions
  seed: number;
  level: number;      // = options.difficulty
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

export function generate(seed: number, options: Options): Spec {
  const rng = new Rng(seed);
  const opts: Options = { difficulty: options.difficulty, features: normalizeFeatures(options.features) };
  const cfg = LEVELS[opts.difficulty];
  for (let i = 0; i < 1000; i++) {
    const g = tryGenerate(rng, cfg, opts.features);
    if (g) {
      // directories to be copied/moved carry a hidden marker file with this token,
      // so a directory made with mkdir (and then renamed) is recognised.
      for (const [rel, n] of Object.entries(g.targets)) {
        if (n.type === 'dir' && n.mode === 'restricted') n.token = hex8(hash32(`${seed}:${rel}`));
      }
      return { ...g, options: opts, seed, level: opts.difficulty, created: new Date().toISOString() };
    }
  }
  throw new Error('could not generate an exercise');
}

function splitext(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i <= 0 ? [name, ''] : [name.slice(0, i), name.slice(i)];
}

function tryGenerate(rng: Rng, cfg: Cfg, f: Features): { targets: Record<string, Target>; junk: Record<string, Junk>; groups: Group[] } | null {
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
    const pRestricted = f.copyMove ? cfg.restricted : 0;
    if (r < pRestricted) modes.set(rel, 'restricted');
    else if (r < pRestricted + cfg.exists && (pm === undefined || pm === 'exists')) modes.set(rel, 'exists');
    else modes.set(rel, 'create');
  }

  const types = new Map(nodes);
  const rels = [...modes.keys()];
  const restricted = rels.filter(r => modes.get(r) === 'restricted');
  const creates = rels.filter(r => modes.get(r) === 'create');
  const rfiles = rels.filter(r => (modes.get(r) === 'restricted' || modes.get(r) === 'inherit') && types.get(r) === 'file');
  if (f.copyMove) {
    if (!(restricted.length >= 2 && restricted.length <= Math.max(2, nodes.length * 0.4))) return null;
    if (rfiles.length < 1) return null;
  }
  if (creates.length < 3) return null;
  if (!creates.some(r => types.get(r) === 'dir') || !creates.some(r => types.get(r) === 'file')) return null;

  // ---- path-style requirements on some of the items the student creates
  const styles = new Map<string, Style>();
  const pool = creates.slice();
  rng.shuffle(pool);
  const wanted = (['abs', 'rel', 'home'] as const).filter(k => f[k]);
  if (pool.length < wanted.length) return null;
  for (const k of wanted) styles.set(pool.pop()!, k);              // every chosen kind shows up at least once
  for (const k of wanted) if (k !== 'home' && pool.length > 1 && rng.next() < 0.5) styles.set(pool.pop()!, k);

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

  // ---- some restricted items must be brought over with `.` as destination (cd there first)
  if (f.dot) {
    const dotCands = nodes.filter(([r]) => modes.get(r) === 'restricted' && basename(r) === basename(sources.get(r)!)).map(([r]) => r);
    if (!dotCands.length) return null;
    for (const r of rng.sample(dotCands, rng.int(1, Math.min(dotCands.length, cfg.depth === 3 ? 2 : 1)))) styles.set(r, 'dot');
  }

  // ---- wildcard groups: several files in ~/stock that must be moved with one * or ? pattern
  const groups: Group[] = [];
  const globFiles = new Set<string>();
  const kinds: Group['kind'][] = [];
  if (f.star) kinds.push(rng.choice<Group['kind']>(['prefix', 'suffix']));
  if (f.question) kinds.push('single');
  for (const kind of kinds) {
    const dirs = nodes.filter(([r, t]) => t === 'dir' && (modes.get(r) === 'create' || modes.get(r) === 'exists')
      && !groups.some(g => g.dir === r)).map(([r]) => r);
    if (!dirs.length) return null;
    const dir = rng.choice(dirs);
    const srcs = [...sources.values()];
    const parents = ['stock', ...STOCK_SUBDIRS.map(x => 'stock/' + x)]
      .filter(p => !srcs.some(s => p === s || p.startsWith(s + '/')));
    const parent = rng.choice(parents);
    const g = makeGroup(rng, kind);
    const dest = g.files.map(f => dir + '/' + f);
    const here = [...g.files, ...g.decoys].map(f => parent + '/' + f);
    if (dest.some(d => occupied.has(d)) || here.some(h => occupied.has(h) || srcs.includes(h))) return null;
    // the pattern must not catch anything else that lives next to the group
    const re = patternRegex(g.pattern);
    if ([...occupied, ...srcs].some(o => dirname(o) === parent && re.test(basename(o)))) return null;
    g.files.forEach((f, i) => {
      nodes.push([dest[i], 'file']);
      modes.set(dest[i], 'restricted');
      sources.set(dest[i], parent + '/' + f);
      occupied.add(dest[i]);
      globFiles.add(dest[i]);
    });
    here.forEach(h => occupied.add(h));
    groups.push({ ...g, dir, parent });
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

  if (f.remove) {
    const nJunkDirs = rng.int(...cfg.junkDirs);
    for (let i = 0; i < nJunkDirs; i++) {
      const p = place(JUNK_DIRS);
      if (p) junk[p] = { type: 'dir', rmdirOnly: f.rmdirOnly && (i === 0 || rng.next() < 0.5), style: null, nonempty: false };
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
        for (const x of rng.sample([...JUNK_FILES, ...FILE_WORDS], rng.int(1, 3))) {
          junk[p + '/' + x] = { type: 'file', rmdirOnly: false, style: null, nonempty: false, child: true };
        }
      }
    }
    const junkVals = Object.values(junk);
    if (!junkVals.length || (f.rmdirOnly && !junkVals.some(j => j.rmdirOnly))) return null;
    if (wanted.length && rng.next() < 0.5) {
      const cands = Object.keys(junk).filter(r => !junk[r].child);
      junk[rng.choice(cands)].style = rng.choice<Style>([...wanted]);
    }
  }

  const targets: Record<string, Target> = {};
  for (const [rel, typ] of nodes) {
    const mode = modes.get(rel)!;
    const token = (mode === 'restricted' || mode === 'inherit') && typ === 'file' ? hex8(rng.bits32()) : null;
    targets[rel] = { type: typ, mode, source: sources.get(rel) ?? null, style: styles.get(rel) ?? null, token,
      ...(globFiles.has(rel) ? { glob: true } : {}) };
  }
  return { targets, junk, groups };
}

function patternRegex(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

const PREFIXES = ['foto', 'verslag', 'notitie', 'taak', 'rapport'];

function makeGroup(rng: Rng, kind: Group['kind']): Omit<Group, 'dir' | 'parent'> {
  if (kind === 'prefix') {
    const p = rng.choice(PREFIXES);
    const ext = rng.choice(['.jpg', '.txt', '.md', '.pdf']);
    const sfx = rng.sample(['a', 'b', 'c', 'd', 'jan', 'feb', 'mrt'], 3);
    const others = rng.sample(PREFIXES.filter(x => x !== p), 2);
    return { kind, files: sfx.map(x => `${p}_${x}${ext}`), decoys: others.map((q, i) => `${q}_${sfx[i]}${ext}`),
      pattern: `${p}*`, parts: [p] };
  }
  if (kind === 'suffix') {
    const ext = rng.choice(['.csv', '.log', '.png', '.sql']);
    const stems = rng.sample(['data', 'export', 'backup', 'stats', 'totaal'], 3);
    const other = rng.choice(['.txt', '.bak', '.old']);
    return { kind, files: stems.map(x => x + ext), decoys: [stems[0] + other, stems[1] + other],
      pattern: `*${ext}`, parts: [ext] };
  }
  const base = rng.choice(['les', 'dag', 'week', 'hoofdstuk']);
  const digits = rng.sample(['1', '2', '3', '4', '5'], 3);
  return { kind, files: digits.map(d => `${base}${d}.txt`), decoys: [`${base}10.txt`, `${base}.txt`],
    pattern: `${base}?.txt`, parts: [base, '.txt'] };
}
