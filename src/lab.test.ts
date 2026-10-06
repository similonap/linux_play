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
  const { targets, junk } = s.lab.spec;
  const run = (c: string) => s.run(c);
  // 1. everything the student has to create
  for (const [rel, n] of Object.entries(targets)) {
    if (n.mode !== 'create') continue;
    const p = n.style === 'rel' ? rel.slice('work/'.length) : `${ROOT}/${rel}`;
    run(`${n.type === 'dir' ? 'mkdir' : 'touch'} ${p}`);
  }
  // 2. then move the restricted items; deepest sources first, because a source can
  //    live inside another directory that is moved as well
  const restricted = Object.entries(targets).filter(([, n]) => n.mode === 'restricted')
    .sort((x, y) => y[1].source!.split('/').length - x[1].source!.split('/').length);
  for (const [rel, n] of restricted) run(`mv ${ROOT}/${n.source} ${ROOT}/${rel}`);
  for (const [rel, j] of Object.entries(junk)) {
    if (j.child) continue;
    const p = j.style === 'rel' ? rel.slice('work/'.length) : `${ROOT}/${rel}`;
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
    expect(s.prompt()).toBe('student@lab:~/work$ ');
  });

  it('supports wildcards, cd and tab completion', () => {
    const s = newSession(1, 1);
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
    a.run('touch zzz');
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
    s.run('mkdir x');
    s.run('touch x/f');
    s.run('cp -r x y');
    expect(strip(s.run('ls -l'))).toMatch(/drwxr-xr-x/);
    expect(strip(s.run('tree y'))).toContain('1 directory, 1 file'.replace('1 directory', '0 directories'));
    expect(strip(s.run('cp x z'))).toContain('-r not specified');
    expect(strip(s.run('mv nope z'))).toContain('cannot stat');
  });
});
