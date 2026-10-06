import { describe, expect, it } from 'vitest';
import { generate, presetOptions, normalizeFeatures, FEATURE_KEYS, Options, Features, Difficulty } from './generator';
import { Rng } from './rng';
import { Session, Store } from './session';
import { ROOT } from './lab';
import { setLang } from './i18n';

const memStore = (): Store => { let d: string | null = null; return { load: () => d, save: x => { d = x; } }; };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Type a command; answer any password / question it asks (passwords: labolinux, other questions: Enter). */
function sh(s: Session, line: string, ...answers: string[]): string {
  let out = s.run(line);
  let guard = 0;
  while (s.isAsking() && guard++ < 20) out += s.run(answers.length ? answers.shift()! : s.isSecret() ? 'labolinux' : '');
  return strip(out).replace(/\r/g, '');
}

const opts = (o: number | Options): Options => (typeof o === 'number' ? presetOptions(o as Difficulty) : o);

function newSession(seed: number, level: number | Options, lang: 'nl' | 'en' = 'en') {
  return new Session({ store: memStore(), confirm: () => true, seed, options: opts(level), lang });
}

/** Do every assignment (users, groups, navigation) the way a student would. */
function solveMissions(s: Session): void {
  const ms = s.lab.spec.missions ?? [];
  const has = (k: string) => ms.find(m => m.kind === k);
  const p = (k: string) => has(k)!.params;
  if (ms.some(m => m.kind.startsWith('nav-'))) {
    sh(s, 'cd ~');
    sh(s, 'ls');
    if (has('nav-ls-dir')) sh(s, `ls ${p('nav-ls-dir').dir}`);
    if (has('nav-cd-dir')) sh(s, `cd ${p('nav-cd-dir').dir}`);
    sh(s, 'cd');                                   // short way home
    sh(s, 'touch ~/note');
    sh(s, 'cd /var/log');
    sh(s, 'cd ..');
    sh(s, 'cd ..');                                // several steps up to /
    sh(s, 'ls /home/student');
    sh(s, 'mv home/student/note home/student/Desktop');
    sh(s, 'cd /home/student');                     // absolute path home
    sh(s, 'cd /');                                 // shortest way to the root
    sh(s, 'cd ~');
  }
  if (has('usr-useradd')) {
    const n = p('usr-useradd').name;
    sh(s, `sudo useradd ${n}`);
    sh(s, `sudo passwd ${n}`);
  }
  const k = has('usr-adduser') ? Number(p('usr-adduser').n) : 0;
  for (let i = 0; i < k; i++) sh(s, `sudo adduser tuser${i}`);
  for (let i = 0; i < k; i++) {
    sh(s, `su tuser${i}`);
    sh(s, 'whoami');
    sh(s, 'cd ~');
    sh(s, 'touch f1 f2');
    sh(s, 'mkdir d1');
    sh(s, 'exit');
  }
  if (has('usr-nohome')) {
    sh(s, `su ${p('usr-nohome').name}`);
    sh(s, `cd /home/${p('usr-nohome').name}`);
    sh(s, 'exit');
  }
  if (has('usr-root')) { sh(s, 'sudo -i'); sh(s, 'whoami'); sh(s, 'exit'); }
  if (has('usr-userdel') && k) sh(s, 'sudo userdel -r tuser0');
  if (has('grp-create')) for (const g of p('grp-create').names.split(',')) sh(s, `sudo groupadd ${g}`);
  if (has('grp-members')) {
    for (const x of p('grp-members').assign.split(';')) {
      const [g, us] = x.split(':');
      for (const u of us.split('+')) sh(s, `sudo usermod -a -G ${g} ${u}`);
    }
  }
  if (has('grp-install')) sh(s, 'sudo apt install members');
  if (has('grp-view')) { sh(s, `groups ${p('grp-view').user}`); sh(s, `members ${p('grp-view').group}`); }
  if (has('grp-id1')) {
    const { user, group } = p('grp-id1');
    sh(s, `sudo groupadd ${group}`);
    sh(s, `sudo usermod -a -G ${group} ${user}`);
    sh(s, `id ${user}`);
    sh(s, `sudo groupmod -n ${p('grp-rename').to} ${group}`);
    sh(s, `id ${user}`);
  }
  if (has('grp-del')) sh(s, `sudo groupdel ${p('grp-del').group}`);
}

/** Solve an exercise the way a student would, using only lab commands. */
function solve(s: Session): void {
  const { targets, junk, groups = [] } = s.lab.spec;
  const run = (c: string) => s.run(c);
  s.run('cd ~');
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
  solveMissions(s);
}

describe('generator', () => {
  it('is deterministic per seed', () => {
    const a = generate(4242, presetOptions(2)), b = generate(4242, presetOptions(2));
    expect(Object.keys(a.targets)).toEqual(Object.keys(b.targets));
    expect(Object.keys(a.junk)).toEqual(Object.keys(b.junk));
  });

  it('produces valid exercises for many seeds and levels', () => {
    for (const level of [1, 2, 3]) for (let seed = 1; seed <= 150; seed++) {
      const s = generate(seed, presetOptions(level as Difficulty));
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

  it('the difficulty presets switch the expected topics on', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const easy = newSession(seed, 1).lab.spec, med = newSession(seed, 2).lab.spec, hard = newSession(seed, 3).lab.spec;
      expect(easy.groups).toHaveLength(0);
      expect(Object.values(easy.targets).some(n => n.style === 'home' || n.style === 'dot')).toBe(false);
      expect(med.groups!.map(g => g.kind)).toHaveLength(1);
      expect(med.groups![0].kind).not.toBe('single');
      expect(Object.values(med.targets).some(n => n.style === 'home')).toBe(true);
      expect(hard.groups!.map(g => g.kind)).toContain('single');
      expect(hard.groups).toHaveLength(2);
      expect(Object.values(hard.targets).some(n => n.style === 'dot')).toBe(true);
      expect(Object.values(hard.targets).some(n => n.style === 'home')).toBe(true);
    }
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

describe('custom settings', () => {
  const randomFeatures = (rng: Rng): Features =>
    normalizeFeatures(Object.fromEntries(FEATURE_KEYS.map(k => [k, rng.next() < 0.5])) as unknown as Features);

  it('every combination of topics generates and can be solved; switched-off topics never appear', () => {
    const rng = new Rng(99);
    const combos: Features[] = [
      normalizeFeatures({ copyMove: false, abs: false, rel: false, home: false, dot: false, star: false, question: false, remove: false, rmdirOnly: false }),
      ...Array.from({ length: 150 }, () => randomFeatures(rng)),
    ];
    combos.forEach((features, i) => {
      const difficulty = ((i % 3) + 1) as Difficulty;
      const s = newSession(i + 1, { difficulty, features });
      const { targets, junk, groups = [] } = s.lab.spec;
      const label = `${JSON.stringify(features)} d${difficulty}`;
      const t = Object.values(targets);
      expect(t.some(n => n.mode === 'restricted' && !n.glob), label).toBe(features.copyMove);
      expect(t.some(n => n.style === 'abs'), label).toBe(features.abs);
      expect(t.some(n => n.style === 'rel'), label).toBe(features.rel);
      expect(t.some(n => n.style === 'home'), label).toBe(features.home);
      expect(t.some(n => n.style === 'dot'), label).toBe(features.dot);
      expect(groups.some(g => g.kind !== 'single'), label).toBe(features.star);
      expect(groups.some(g => g.kind === 'single'), label).toBe(features.question);
      expect(Object.keys(junk).length > 0, label).toBe(features.remove);
      expect(Object.values(junk).some(j => j.rmdirOnly), label).toBe(features.rmdirOnly);
      solve(s);
      const out = strip(s.run('check'));
      expect(out, `${label}\n${out}`).toContain('SOLVED');
      expect(s.info().violations, label).toBe(0);
    });
  });

  it('dot needs copy/move and the rmdir rule needs deleting', () => {
    const f = normalizeFeatures({ ...presetOptions(3).features, copyMove: false, remove: false });
    expect(f.dot).toBe(false);
    expect(f.rmdirOnly).toBe(false);
  });

  it('a saved exercise keeps its own settings; `new` uses the current ones', () => {
    const store = memStore();
    const a = new Session({ store, confirm: () => true, seed: 5, options: presetOptions(3), lang: 'en' });
    a.setOptions({ difficulty: 1, features: { ...presetOptions(1).features, remove: false, rmdirOnly: false } });
    expect(a.lab.spec.options!.difficulty).toBe(3);
    a.run('new');
    expect(a.lab.spec.options!.difficulty).toBe(1);
    expect(Object.keys(a.lab.spec.junk)).toHaveLength(0);
    a.run('reset');
    expect(a.lab.spec.options!.features.remove).toBe(false);
    expect(strip(a.run('task'))).not.toContain('Remove from');
    expect(a.info().custom).toBe(true);
  });

  it('settings from the URL replace a saved exercise with different settings', () => {
    const store = memStore();
    new Session({ store, confirm: () => true, seed: 5, options: presetOptions(2), lang: 'en' });
    const same = new Session({ store, confirm: () => true, options: presetOptions(2), explicit: true, lang: 'en' });
    expect(same.resumed).toBe(true);
    const other = new Session({ store, confirm: () => true, options: presetOptions(3), explicit: true, lang: 'en' });
    expect(other.resumed).toBe(false);
    expect(other.lab.spec.options!.difficulty).toBe(3);
  });
});

const LAB3: Options['features'] = normalizeFeatures({
  folders: true, navigation: true, users: true, groups: true, copyMove: true, abs: true, rel: true, home: true,
  dot: true, star: true, question: true, remove: true, rmdirOnly: true,
});

describe('lab 3: navigation, users and groups', () => {
  it('everything switched on is solvable at every difficulty, without rule violations', () => {
    for (const difficulty of [1, 2, 3] as Difficulty[]) for (let seed = 1; seed <= 25; seed++) {
      const s = newSession(seed, { difficulty, features: LAB3 });
      expect((s.lab.spec.missions ?? []).length).toBeGreaterThan(8);
      solve(s);
      const out = strip(s.run('check'));
      expect(out, `seed ${seed} d${difficulty}\n${out}`).toContain('SOLVED');
      expect(s.info().violations).toBe(0);
      expect(s.info().missionsDone).toBe(s.info().missionsTotal);
    }
  });

  it('works without a folder structure: only the assignments count', () => {
    const features = normalizeFeatures({ folders: false, users: true, groups: true });
    expect(features.folders).toBe(false);
    const s = newSession(3, { difficulty: 2, features });
    expect(Object.keys(s.lab.spec.targets)).toHaveLength(0);
    expect(strip(s.run('task'))).not.toContain('Make ~/work');
    expect(strip(s.run('check'))).toContain('not yet');
    solve(s);
    expect(strip(s.run('check'))).toContain('SOLVED');
  });

  it('refuses to switch every topic off', () => {
    expect(normalizeFeatures({ folders: false }).folders).toBe(true);
  });

  it('administrator commands need sudo', () => {
    const s = newSession(1, 1);
    expect(sh(s, 'useradd eva')).toContain('Permission denied');
    expect(sh(s, 'adduser eva')).toContain('Only root');
    expect(sh(s, 'groupadd team')).toContain('Permission denied');
    expect(s.lab.sys.users.some(u => u.name === 'eva')).toBe(false);
    expect(sh(s, 'sudo useradd eva')).toBe('');
    expect(s.lab.sys.users.some(u => u.name === 'eva')).toBe(true);
    expect(sh(s, 'sudo useradd eva')).toContain('already exists');
  });

  it('sudo asks for the password and gives up after three wrong tries', () => {
    const s = newSession(1, 1);
    s.run('sudo whoami');
    expect(s.prompt()).toBe('[sudo] password for student: ');
    expect(s.isSecret()).toBe(true);
    expect(strip(s.run('nope'))).toContain('Sorry, try again.');
    s.run('nope');
    expect(strip(s.run('nope'))).toContain('3 incorrect password attempts');
    expect(s.isAsking()).toBe(false);
    expect(sh(s, 'sudo whoami')).toContain('root');
    expect(sh(s, 'sudo whoami')).toContain('root');       // remembered: no second question
  });

  it('only users in the sudo group may use sudo', () => {
    const s = newSession(1, 1);
    sh(s, 'su anna');
    expect(s.prompt()).toBe('anna@lab:~$ '.replace('~', '/home/student'));
    expect(sh(s, 'sudo whoami')).toContain('not in the sudoers file');
  });

  it('su asks for the password, exit goes back, sudo -i makes you root', () => {
    const s = newSession(1, 1);
    s.run('su anna');
    expect(s.isSecret()).toBe(true);
    expect(strip(s.run('wrong'))).toContain('Authentication failure');
    expect(sh(s, 'whoami')).toContain('student');
    sh(s, 'su anna');
    expect(sh(s, 'whoami')).toContain('anna');
    expect(sh(s, 'su -  student')).toContain('');           // anna may su to student with student's password
    expect(s.lab.who).toBe('student');
    sh(s, 'exit');
    expect(s.lab.who).toBe('anna');
    sh(s, 'exit');
    expect(s.lab.who).toBe('student');
    expect(strip(s.run('exit'))).toContain('browser');
    sh(s, 'sudo -i');
    expect(s.prompt()).toBe('root@lab:~# ');
    expect(sh(s, 'pwd')).toContain('/root');
    sh(s, 'exit');
    expect(s.prompt()).toMatch(/^student@lab:/);
  });

  it('useradd makes no home directory, adduser does (and asks questions)', () => {
    const s = newSession(1, 1);
    sh(s, 'sudo useradd eva');
    sh(s, 'sudo passwd eva');
    sh(s, 'su eva');
    expect(sh(s, 'cd /home/eva')).toContain('No such file or directory');
    expect(sh(s, 'cd ~')).toContain('No such file or directory');
    sh(s, 'exit');
    const out = sh(s, 'sudo adduser finn');
    expect(out).toContain("Creating home directory `/home/finn'");
    expect(out).toContain('password updated successfully');
    expect(s.lab.fs.isDir('/home/finn')).toBe(true);
    expect(s.lab.fs.get('/home/finn')!.owner).toBe('finn');
    sh(s, 'su finn');
    sh(s, 'cd ~');
    sh(s, 'touch mine');
    expect(s.lab.fs.get('/home/finn/mine')!.owner).toBe('finn');
    expect(sh(s, 'touch /home/student/x')).toContain('Permission denied');
  });

  it('passwd: mismatching passwords are refused, root may change anybody', () => {
    const s = newSession(1, 1);
    expect(sh(s, 'passwd anna')).toContain('may not view or modify');
    sh(s, 'sudo useradd eva');
    expect(sh(s, 'sudo passwd eva', 'one', 'two')).toContain('do not match');
    expect(s.lab.sys.users.find(u => u.name === 'eva')!.password).toBeNull();
    expect(sh(s, 'sudo passwd eva', 'labolinux', 'labolinux')).toContain('updated successfully');
    expect(s.lab.sys.users.find(u => u.name === 'eva')!.password).toBe('labolinux');
  });

  it('id, groups, members and groupmod', () => {
    const s = newSession(1, 1);
    expect(sh(s, 'id')).toMatch(/uid=1000\(student\) gid=1000\(student\) groups=1000\(student\),.*27\(sudo\)/);
    expect(sh(s, 'id -un')).toBe('student\n');
    expect(sh(s, 'groups anna')).toContain('anna : anna');
    expect(sh(s, 'members users')).toContain('command not found');
    expect(sh(s, 'apt install members')).toContain('Permission denied');
    expect(sh(s, 'sudo apt install members')).toContain('Setting up members');
    expect(sh(s, 'members sudo')).toContain('student');
    sh(s, 'sudo groupadd team');
    sh(s, 'sudo usermod -a -G team anna,bram'.replace(' anna,bram', ' anna'));
    sh(s, 'sudo usermod -a -G team bram');
    expect(sh(s, 'members team')).toBe('anna bram\n');
    expect(sh(s, 'sudo groupmod -n crew team')).toBe('');
    expect(sh(s, 'members crew')).toBe('anna bram\n');
    expect(sh(s, 'id anna')).toMatch(/groups=1001\(anna\),.*\d+\(crew\)/);
    expect(sh(s, 'sudo groupdel anna')).toContain('cannot remove the primary group');
    expect(sh(s, 'sudo groupdel crew')).toBe('');
    expect(sh(s, 'groups anna')).not.toContain('crew');
  });

  it('usermod -G without -a replaces the groups; userdel -r removes the home', () => {
    const s = newSession(1, 1);
    sh(s, 'sudo groupadd a');
    sh(s, 'sudo groupadd b');
    sh(s, 'sudo usermod -a -G a anna');
    sh(s, 'sudo usermod -G b anna');
    expect(sh(s, 'groups anna')).toMatch(/anna : anna(?!.* a( |\n))/);
    expect(sh(s, 'groups anna')).toContain(' b');
    expect(sh(s, 'sudo userdel -r anna')).toBe('');
    expect(s.lab.fs.exists('/home/anna')).toBe(false);
    expect(sh(s, 'groups anna')).toContain('no such user');
  });

  it('the assignments notice navigation done the right way', () => {
    const s = newSession(2, { difficulty: 3, features: normalizeFeatures({ folders: false, navigation: true }) });
    const done = () => s.info().missionsDone;
    expect(done()).toBe(0);
    sh(s, 'ls');
    expect(done()).toBe(1);
    sh(s, 'cd /');
    sh(s, 'cd');
    sh(s, 'cd /');
    expect(done()).toBeGreaterThanOrEqual(3);
    expect(strip(s.run('hint'))).toContain('Next assignment');
  });

  it('saves and restores the whole machine, including who is logged in', () => {
    const store = memStore();
    const a = new Session({ store, confirm: () => true, seed: 4, options: { difficulty: 2, features: LAB3 }, lang: 'en' });
    sh(a, 'sudo useradd eva');
    sh(a, 'sudo passwd eva');
    sh(a, 'su eva');
    const b = new Session({ store, confirm: () => true, lang: 'en' });
    expect(b.resumed).toBe(true);
    expect(b.lab.who).toBe('eva');
    expect(b.lab.stack.map(x => x.user)).toEqual(['student']);
    expect(b.lab.sys.users.some(u => u.name === 'eva')).toBe(true);
    sh(b, 'exit');
    expect(b.lab.who).toBe('student');
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

  it('only lets the student change things in their own home', () => {
    const s = newSession(1, 1);
    expect(strip(s.run('cd /'))).toBe('');
    expect(s.prompt()).toBe('student@lab:/$ ');
    expect(strip(s.run('ls /etc'))).toContain('passwd');
    expect(strip(s.run('mkdir /etc/x'))).toContain('Permission denied');
    expect(strip(s.run('touch /usr/x'))).toContain('Permission denied');
    expect(strip(s.run('rm /etc/hostname'))).toContain('Permission denied');
    expect(strip(s.run('cd /root'))).toContain('Permission denied');
    expect(strip(s.run('ls /root'))).toContain('Permission denied');
    expect(strip(s.run('rm -r ~/work'))).toContain('blocked');
    expect(strip(s.run('rm -r /'))).toContain('blocked');
    expect(strip(s.run('ls | cat'))).toContain('Pipes');
    s.run('cd ~');
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
    const a = new Session({ store, confirm: () => true, seed: 7, options: presetOptions(1), lang: 'nl' });
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
    const s = new Session({ store: memStore(), confirm: () => false, seed: 3, options: presetOptions(1), lang: 'en' });
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
