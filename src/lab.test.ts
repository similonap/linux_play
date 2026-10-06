import { describe, expect, it } from 'vitest';
import { generate } from './generator';
import { Session, Store } from './session';
import { ROOT } from './lab';
import { setLang } from './i18n';

const memStore = (): Store => { let d: string | null = null; return { load: () => d, save: x => { d = x; } }; };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

function newSession(seed: number, level: number, lang: 'nl' | 'en' = 'en') {
  return new Session({ store: memStore(), confirm: () => true, seed, level, lang });
}

/** Solve an exercise the way a student would, using only lab commands. */
function solve(s: Session): void {
  const { targets, junk, groups = [] } = s.lab.spec;
  const run = (c: string) => s.run(c);
  const path = (style: string | null, rel: string) =>
    style === 'rel' ? rel : style === 'home' ? `~/${rel}` : `${ROOT}/${rel}`;
  // 1. everything the student has to create
  for (const [rel, n] of Object.entries(targets)) {
    if (n.mode !== 'create') continue;
    run(`${n.type === 'dir' ? 'mkdir' : 'touch'} ${path(n.style, rel)}`);
  }
  // 2. wildcard groups: one pattern each
  for (const g of groups) run(`mv ${ROOT}/${g.parent}/${g.pattern} ${ROOT}/${g.dir}`);
  // 3. the other restricted items; deepest sources first, because a source can
  //    live inside another directory that is moved as well
  const restricted = Object.entries(targets).filter(([, n]) => n.mode === 'restricted' && !n.glob)
    .sort((x, y) => y[1].source!.split('/').length - x[1].source!.split('/').length);
  for (const [rel, n] of restricted) {
    if (n.style === 'dot') {
      run(`cd ${ROOT}/${rel.slice(0, rel.lastIndexOf('/'))}`);
      run(`mv ${ROOT}/${n.source} .`);
      run('cd ~');
    } else run(`mv ${ROOT}/${n.source} ${ROOT}/${rel}`);
  }
  for (const [rel, j] of Object.entries(junk)) {
    if (j.child) continue;
    const p = path(j.style, rel);
    run(j.rmdirOnly ? `rmdir ${p}` : j.type === 'dir' ? `rm -r ${p}` : `rm ${p}`);
  }
}

describe('generator', () => {
  it('is deterministic per seed', () => {
    const a = generate(4242, 2), b = generate(4242, 2);
    expect(Object.keys(a.targets)).toEqual(Object.keys(b.targets));
    expect(Object.keys(a.junk)).toEqual(Object.keys(b.junk));
  });

  it('produces valid exercises for many seeds and levels', () => {
    for (const level of [1, 2, 3]) for (let seed = 1; seed <= 150; seed++) {
      const s = generate(seed, level);
      expect(Object.keys(s.targets).length).toBeGreaterThan(3);
      expect(Object.values(s.junk).some(j => j.rmdirOnly)).toBe(true);
    }
  });
});

describe('wildcards, ~ and .', () => {
  const find = (level: number, pred: (s: Session) => boolean) => {
    for (let seed = 1; seed < 300; seed++) { const s = newSession(seed, level); if (pred(s)) return s; }
    throw new Error('no such exercise');
  };

  it('levels 2 and 3 always have a wildcard group; level 3 usually uses ~ and . too', () => {
    let dot = 0, home = 0;
    for (let seed = 1; seed <= 100; seed++) {
      expect(newSession(seed, 2).lab.spec.groups!.length).toBe(1);
      const l3 = newSession(seed, 3).lab.spec;
      expect(l3.groups!.length).toBeGreaterThanOrEqual(1);
      if (Object.values(l3.targets).some(n => n.style === 'dot')) dot++;
      if (Object.values(l3.targets).some(n => n.style === 'home')) home++;
    }
    expect(dot).toBeGreaterThan(70);
    expect(home).toBeGreaterThan(95);
  });

  it('group files cannot be moved one by one, but can with the pattern', () => {
    const s = newSession(5, 2);
    const g = s.lab.spec.groups![0];
    s.lab.fs.mkdirp(`${ROOT}/${g.dir}`);
    const out = strip(s.run(`mv ${ROOT}/${g.parent}/${g.files[0]} ${ROOT}/${g.dir}`));
    expect(out).toContain('wildcard');
    expect(s.info().violations).toBe(1);
    const st = s.info().violations;
    s.run(`mv ${ROOT}/${g.parent}/${g.pattern} ${ROOT}/${g.dir}`);
    expect(s.info().violations).toBe(st);
    for (const f of g.files) expect(s.lab.fs.exists(`${ROOT}/${g.dir}/${f}`)).toBe(true);
    for (const d of g.decoys) expect(s.lab.fs.exists(`${ROOT}/${g.parent}/${d}`)).toBe(true);
  });

  it('a pattern that is too greedy drags the look-alikes along and fails the check', () => {
    const s = newSession(5, 2);
    const g = s.lab.spec.groups![0];
    s.lab.fs.mkdirp(`${ROOT}/${g.dir}`);
    s.run(`mv ${ROOT}/${g.parent}/* ${ROOT}/${g.dir}`);
    expect(strip(s.run('check'))).toContain('should not be there');
  });

  it('? matches exactly one character', () => {
    const s = newSession(1, 1);
    s.run('cd work');
    s.run('touch a1 a2 a10');
    expect(strip(s.run('ls a?'))).toMatch(/a1\s+a2/);
    expect(strip(s.run('ls a?'))).not.toContain('a10');
  });

  it('~ items refuse a plain absolute path', () => {
    const s = find(3, x => Object.values(x.lab.spec.targets).some(n => n.style === 'home' && n.mode === 'create'));
    const [rel, n] = Object.entries(s.lab.spec.targets).find(([, t]) => t.style === 'home' && t.mode === 'create')!;
    const cmd = n.type === 'dir' ? 'mkdir -p' : 'touch';
    if (n.type === 'file') s.lab.fs.mkdirp(`${ROOT}/${rel.slice(0, rel.lastIndexOf('/'))}`);
    expect(strip(s.run(`${cmd} ${ROOT}/${rel}`))).toContain('~');
    expect(s.info().violations).toBe(1);
    s.run(`${cmd} ~/${rel}`);
    expect(s.info().violations).toBe(1);
    expect(s.lab.fs.exists(`${ROOT}/${rel}`)).toBe(true);
  });

  it('. items need cd + `.` as destination', () => {
    const s = find(3, x => Object.values(x.lab.spec.targets).some(n => n.style === 'dot'));
    const [rel, n] = Object.entries(s.lab.spec.targets).find(([, t]) => t.style === 'dot')!;
    const parent = rel.slice(0, rel.lastIndexOf('/'));
    s.lab.fs.mkdirp(`${ROOT}/${parent}`);
    const flag = n.type === 'dir' ? '-r ' : '';
    expect(strip(s.run(`cp ${flag}${ROOT}/${n.source} ${ROOT}/${rel}`))).toContain('.');
    expect(s.info().violations).toBe(1);
    s.run(`cd ${ROOT}/${parent}`);
    s.run(`cp ${flag}${ROOT}/${n.source} .`);
    expect(s.info().violations).toBe(1);
    expect(s.lab.fs.exists(`${ROOT}/${rel}`)).toBe(true);
  });

  it('cp -r . copies the contents, and path/./sub equals path/sub', () => {
    const s = newSession(1, 1);
    s.run('cd work');
    s.run('mkdir -p a/b');
    s.run('touch a/b/f');
    s.run('mkdir dst');
    s.run('cd a');
    s.run('cp -r . ../dst');
    expect(s.lab.fs.exists(`${ROOT}/work/dst/b/f`)).toBe(true);
    expect(s.lab.fs.exists(`${ROOT}/work/dst/a`)).toBe(false);
    expect(strip(s.run('ls ./b/./'))).toContain('f');
    expect(strip(s.run('mv . ../dst'))).toContain('busy');
  });
});

describe('lab', () => {
  it('every generated exercise can be solved with the allowed commands, without violations', () => {
    for (const level of [1, 2, 3]) for (let seed = 1; seed <= 60; seed++) {
      const s = newSession(seed, level);
      expect(s.lab.isSolved()).toBe(false);
      solve(s);
      const out = strip(s.run('check'));
      expect(out, `seed ${seed} level ${level}\n${out}`).toContain('SOLVED');
      expect(s.info().violations, `seed ${seed} level ${level}`).toBe(0);
      expect(s.info().solved).toBe(true);
    }
  });

  it('refuses mkdir/touch for items that must be copied or moved, and counts it', () => {
    const s = newSession(4242, 2);
    const [rel] = Object.entries(s.lab.spec.targets).find(([, n]) => n.mode === 'restricted')!;
    const out = strip(s.run(`mkdir -p ${ROOT}/${rel}`));
    expect(out).toContain('rule violation');
    expect(s.info().violations).toBe(1);
    expect(s.lab.fs.exists(`${ROOT}/${rel}`)).toBe(false);
  });

  it('refuses rm on rmdir-only directories', () => {
    const s = newSession(4242, 2);
    const [rel] = Object.entries(s.lab.spec.junk).find(([, j]) => j.rmdirOnly)!;
    const out = strip(s.run(`rm -r ${ROOT}/${rel}`));
    expect(out).toContain('rmdir');
    expect(s.lab.fs.exists(`${ROOT}/${rel}`)).toBe(true);
  });

  it('does not let a recreated item pass the check', () => {
    const s = newSession(4242, 2);
    const [rel, n] = Object.entries(s.lab.spec.targets).find(([, t]) => t.mode === 'restricted' && t.type === 'file')
      ?? Object.entries(s.lab.spec.targets).find(([, t]) => t.mode === 'inherit' && t.type === 'file')!;
    // sneak the file in via the fs, bypassing the rules, with the wrong content
    s.lab.fs.mkdirp(`${ROOT}/${rel}`.replace(/\/[^/]+$/, ''));
    s.lab.fs.writeFile(`${ROOT}/${rel}`, 'fake\n');
    expect(strip(s.run('check'))).toContain(n.source!);
  });

  it('keeps the student inside the lab', () => {
    const s = newSession(1, 1);
    expect(strip(s.run('cd /'))).toContain('blocked');
    expect(strip(s.run('ls /etc'))).toContain('blocked');
    expect(strip(s.run('rm -r ~/work'))).toContain('blocked');
    expect(strip(s.run('ls | cat'))).toContain('Pipes');
    expect(s.prompt()).toBe('student@lab:~$ ');
    s.run('cd work');
    expect(s.prompt()).toBe('student@lab:~/work$ ');
  });

  it('supports wildcards, cd and tab completion', () => {
    const s = newSession(1, 1);
    s.run('cd work');
    s.run('touch a.txt b.txt');
    expect(strip(s.run('ls *.txt'))).toContain('a.txt');
    s.run('mkdir -p sub/deep');
    s.run('cd sub');
    expect(s.prompt()).toBe('student@lab:~/work/sub$ ');
    expect(s.complete('cd d')).toEqual(['deep/']);
    expect(s.complete('mk')).toEqual(['mkdir ']);
  });

  it('resumes from storage and speaks Dutch by default', () => {
    const store = memStore();
    const a = new Session({ store, confirm: () => true, seed: 7, level: 1, lang: 'nl' });
    a.run('touch work/zzz');
    const b = new Session({ store, confirm: () => true, lang: 'nl' });
    expect(b.resumed).toBe(true);
    expect(b.lab.fs.exists(`${ROOT}/work/zzz`)).toBe(true);
    expect(strip(b.run('hint'))).toMatch(/Ontbreekt|hoort er niet/);
    setLang('en');
    expect(strip(b.run('hint'))).toMatch(/Missing|should not/);
    setLang('nl');
  });

  it('new/reset ask for confirmation', () => {
    const s = new Session({ store: memStore(), confirm: () => false, seed: 3, level: 1, lang: 'en' });
    expect(strip(s.run('new'))).toContain('cancelled');
    expect(s.info().seed).toBe(3);
  });

  it('ls -l, tree and cp -r behave', () => {
    const s = newSession(1, 1);
    s.run('cd work');
    s.run('mkdir x');
    s.run('touch x/f');
    s.run('cp -r x y');
    expect(strip(s.run('ls -l'))).toMatch(/drwxr-xr-x/);
    expect(strip(s.run('tree y'))).toContain('1 directory, 1 file'.replace('1 directory', '0 directories'));
    expect(strip(s.run('cp x z'))).toContain('-r not specified');
    expect(strip(s.run('mv nope z'))).toContain('cannot stat');
  });
});
