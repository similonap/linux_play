/**
 * "Missions": things to do besides building the folder structure - navigating
 * the system, managing users and managing groups (lab 3).  A mission is
 * latched as done the moment it is satisfied, so later changes do not undo it.
 */
import { Rng } from './rng';
import { VFS, isAbs, join, normpath } from './vfs';
import { tr } from './i18n';
import { System, PASSWORD, PRESET_USERS, groupBy, userBy } from './world';
import type { Features, Difficulty } from './generator';

export type MissionKind =
  | 'nav-ls-here' | 'nav-ls-dir' | 'nav-cd-dir' | 'nav-cd-short' | 'nav-cd-root-short' | 'nav-cd-root-steps'
  | 'nav-cd-home-abs' | 'nav-ls-home-root' | 'nav-touch-home' | 'nav-mv-desktop'
  | 'usr-useradd' | 'usr-adduser' | 'usr-su-whoami' | 'usr-su-files' | 'usr-nohome' | 'usr-userdel' | 'usr-root'
  | 'grp-create' | 'grp-members' | 'grp-install' | 'grp-view' | 'grp-id1' | 'grp-rename' | 'grp-id2' | 'grp-del';

export interface Mission { id: string; kind: MissionKind; params: Record<string, string> }

/** One finished command line, as seen by the missions. */
export interface Entry {
  line: string;
  cmd: string;
  raw: string[];      // the words as typed (after the command)
  argv: string[];     // arguments after ~ and wildcard expansion
  user: string;       // who ran it
  user1: string;      // who was logged in afterwards (differs for su / sudo -i / exit)
  cwd0: string;
  cwd1: string;
  rc: number;
}

export interface MissionCtx {
  sys: System;
  fs: VFS;
  entries: Entry[];
  cur?: Entry;
  home: string;       // home of the student (~)
}

const GROUP_NAMES = ['studenten', 'docenten', 'labo', 'team', 'alumni', 'projecten', 'beheer', 'gasten'];
const DIRS = ['/etc', '/var/log', '/usr/share', '/var/lib', '/opt', '/usr/bin', '/var/cache'];

// ---- generation ------------------------------------------------------------------------
export function makeMissions(rng: Rng, d: Difficulty, f: Features): Mission[] {
  const out: Mission[] = [];
  const add = (kind: MissionKind, params: Record<string, string> = {}) => out.push({ id: kind, kind, params });

  if (f.navigation) {
    const [x, y] = rng.sample(DIRS, 2);
    add('nav-ls-here');
    add('nav-ls-dir', { dir: x });
    add('nav-cd-dir', { dir: y });
    add('nav-cd-short');
    add('nav-cd-root-short');
    if (d >= 2) { add('nav-cd-root-steps'); add('nav-cd-home-abs'); }
    if (d >= 3) { add('nav-ls-home-root'); add('nav-touch-home'); add('nav-mv-desktop'); }
  }
  if (f.users) {
    const n = d === 1 ? 2 : 3;
    add('usr-useradd');
    add('usr-adduser', { n: String(n) });
    add('usr-su-files', { n: String(n) });
    if (d >= 2) { add('usr-su-whoami', { n: String(n) }); add('usr-userdel'); add('usr-root'); }
    if (d >= 3) add('usr-nohome');
  }
  if (f.groups) {
    const g = rng.sample(GROUP_NAMES, 5);
    const members = g.slice(0, 3).map(() => rng.sample(PRESET_USERS, 2).join('+'));
    const z = rng.choice(PRESET_USERS);
    add('grp-create', { names: g.slice(0, 3).join(',') });
    add('grp-members', { assign: g.slice(0, 3).map((n, i) => `${n}:${members[i]}`).join(';') });
    add('grp-install');
    add('grp-view', { user: z, group: g[0] });
    if (d >= 2) {
      add('grp-id1', { user: z, group: g[3] });
      add('grp-rename', { user: z, from: g[3], to: g[4] });
      add('grp-id2', { user: z, group: g[4] });
    }
    if (d >= 3) add('grp-del', { group: g[2] });
  }
  return out;
}

// ---- wording -----------------------------------------------------------------------------
export function missionText(m: Mission): string {
  const p = m.params;
  switch (m.kind) {
    case 'nav-ls-here': return tr('Show the contents of the current directory.', 'Toon de inhoud van de huidige directory.');
    case 'nav-ls-dir': return tr(`Show the contents of ${p.dir}, from where you are now (do not go there first).`,
      `Toon de inhoud van ${p.dir} vanaf de plaats waar je nu bent (ga er niet eerst naartoe).`);
    case 'nav-cd-dir': return tr(`Go to ${p.dir} with one single command.`, `Ga in één commando naar de directory ${p.dir}.`);
    case 'nav-cd-short': return tr('Go to your home directory by typing at most 3 characters.',
      'Ga naar je home directory door maximaal 3 tekens te typen.');
    case 'nav-cd-root-short': return tr('Go to the root directory / with the shortest possible command.',
      'Ga naar de root directory / met het kortst mogelijke commando.');
    case 'nav-cd-root-steps': return tr('Go to the root directory / in several steps (with ..).',
      'Ga naar de root directory / in meerdere stappen (met ..).');
    case 'nav-cd-home-abs': return tr('Go to your home directory using the absolute (full) path.',
      'Ga naar je home directory door gebruik te maken van het absolute (volledige) path.');
    case 'nav-ls-home-root': return tr('Standing in /, show the contents of your home directory.',
      'Toon vanuit de root directory / de inhoud van jouw home directory.');
    case 'nav-touch-home': return tr('Create a file in your home directory.', 'Maak een bestand in je home directory.');
    case 'nav-mv-desktop': return tr('Standing in /, move the file from your home directory to the Desktop.',
      'Verplaats vanuit de root directory / het bestand uit je home directory naar de Desktop.');
    case 'usr-useradd': return tr(`Create 1 user with useradd (choose the name) and set the password to ${PASSWORD}.`,
      `Creëer 1 user met useradd (kies zelf de naam) en stel het paswoord in op ${PASSWORD}.`);
    case 'usr-adduser': return tr(`Create ${p.n} users with adduser (choose the names) - password ${PASSWORD} for all of them.`,
      `Creëer ${p.n} users met adduser (kies zelf de namen) - paswoord ${PASSWORD} voor allemaal.`);
    case 'usr-su-whoami': return tr(`Take on the identity of each of those ${p.n} users (su) and check with whoami who you are.`,
      `Neem de identiteit aan van elk van die ${p.n} users (su) en controleer met whoami wie je bent.`);
    case 'usr-su-files': return tr(`As each of those ${p.n} users: go to their home directory (check with pwd) and create 2 files and 1 directory there.`,
      `Ga als elk van die ${p.n} users naar hun home directory (controleer met pwd) en maak daar 2 bestanden en 1 directory.`);
    case 'usr-nohome': return tr('Take on the identity of the user you made with useradd and try cd /home/<name>. What do you notice?',
      'Neem de identiteit aan van de user die je met useradd maakte en probeer cd /home/<naam>. Wat merk je?');
    case 'usr-userdel': return tr('Remove one of your users again with userdel.', 'Verwijder één van je users terug met userdel.');
    case 'usr-root': return tr('Become root with sudo -i, check with whoami and return with exit.',
      'Word root met sudo -i, controleer met whoami en keer terug met exit.');
    case 'grp-create': return tr(`Create the groups ${p.names.split(',').join(', ')}.`, `Creëer de groepen ${p.names.split(',').join(', ')}.`);
    case 'grp-members': return tr(`Add two users to each group (usermod -a -G): ${assignText(p.assign)}.`,
      `Voeg per groep 2 users toe (usermod -a -G): ${assignText(p.assign)}.`);
    case 'grp-install': return tr('Install the members command with sudo apt install members.',
      'Installeer het commando members met sudo apt install members.');
    case 'grp-view': return tr(`Look up the groups of ${p.user} with groups, and the members of ${p.group} with members.`,
      `Bekijk de groepen van ${p.user} met groups en de leden van ${p.group} met members.`);
    case 'grp-id1': return tr(`Create the group ${p.group}, add ${p.user} to it and look at ${p.user} with id.`,
      `Maak de groep ${p.group}, voeg ${p.user} eraan toe en bekijk ${p.user} met id.`);
    case 'grp-rename': return tr(`Rename the group ${p.from} to ${p.to} (groupmod -n).`, `Verander de naam van de groep ${p.from} in ${p.to} (groupmod -n).`);
    case 'grp-id2': return tr(`Look at ${p.user} with id again. Do you see the link between the numbers and the names?`,
      `Bekijk ${p.user} opnieuw met id. Zie je het verband tussen de nummers en de namen?`);
    case 'grp-del': return tr(`Delete the group ${p.group} with groupdel.`, `Verwijder de groep ${p.group} met groupdel.`);
  }
}

const assignText = (a: string) => a.split(';').map(x => { const [g, u] = x.split(':'); return `${g}: ${u.split('+').join(' + ')}`; }).join(' | ');

export function missionHint(m: Mission): string {
  const p = m.params;
  switch (m.kind) {
    case 'nav-ls-here': return tr('Use ls without anything behind it.', 'Gebruik ls zonder iets erachter.');
    case 'nav-ls-dir': return tr(`ls with the path ${p.dir} behind it.`, `ls met het pad ${p.dir} erachter.`);
    case 'nav-cd-dir': return tr(`cd ${p.dir}`, `cd ${p.dir}`);
    case 'nav-cd-short': return tr('cd on its own takes you home.', 'cd alleen brengt je naar huis.');
    case 'nav-cd-root-short': return tr('cd / is only 4 characters.', 'cd / is maar 4 tekens.');
    case 'nav-cd-root-steps': return tr('cd .. goes one level up - repeat it until you are in /.', 'cd .. gaat een niveau hoger - herhaal tot je in / bent.');
    case 'nav-cd-home-abs': return tr('Start the path with / (see pwd when you are home).', 'Begin het pad met / (zie pwd als je thuis bent).');
    case 'nav-ls-home-root': return tr('First cd /, then ls home/student or ls /home/student.', 'Doe eerst cd / en dan ls home/student of ls /home/student.');
    case 'nav-touch-home': return tr('touch ~/name (or go home first).', 'touch ~/naam (of ga eerst naar huis).');
    case 'nav-mv-desktop': return tr('cd / first, then mv home/student/<file> home/student/Desktop.', 'Doe eerst cd / en dan mv home/student/<bestand> home/student/Desktop.');
    case 'usr-useradd': return tr('sudo useradd <name>  then  sudo passwd <name>', 'sudo useradd <naam>  daarna  sudo passwd <naam>');
    case 'usr-adduser': return tr('sudo adduser <name> (it asks for the password itself).', 'sudo adduser <naam> (het vraagt zelf om het paswoord).');
    case 'usr-su-whoami': return tr('su <name>, then whoami; exit brings you back.', 'su <naam>, dan whoami; met exit kom je terug.');
    case 'usr-su-files': return tr('su <name>, cd ~ (or cd /home/<name>), touch two files, mkdir one directory, exit.',
      'su <naam>, cd ~ (of cd /home/<naam>), touch twee bestanden, mkdir één map, exit.');
    case 'usr-nohome': return tr('su <name>, then cd /home/<name>. useradd does not create a home directory (unless you give -m).',
      'su <naam>, dan cd /home/<naam>. useradd maakt geen home directory aan (tenzij je -m meegeeft).');
    case 'usr-userdel': return tr('sudo userdel <name> (add -r to remove the home directory too).', 'sudo userdel <naam> (met -r verdwijnt ook de home directory).');
    case 'usr-root': return tr('sudo -i, whoami, exit.', 'sudo -i, whoami, exit.');
    case 'grp-create': return tr('sudo groupadd <group>', 'sudo groupadd <groep>');
    case 'grp-members': return tr('sudo usermod -a -G <group> <user>', 'sudo usermod -a -G <groep> <user>');
    case 'grp-install': return tr('sudo apt install members', 'sudo apt install members');
    case 'grp-view': return tr(`groups ${p.user}  and  members ${p.group}`, `groups ${p.user}  en  members ${p.group}`);
    case 'grp-id1': return tr(`sudo groupadd ${p.group}; sudo usermod -a -G ${p.group} ${p.user}; id ${p.user}`,
      `sudo groupadd ${p.group}; sudo usermod -a -G ${p.group} ${p.user}; id ${p.user}`);
    case 'grp-rename': return tr(`sudo groupmod -n ${p.to} ${p.from}`, `sudo groupmod -n ${p.to} ${p.from}`);
    case 'grp-id2': return tr(`id ${p.user}`, `id ${p.user}`);
    case 'grp-del': return tr(`sudo groupdel ${p.group}`, `sudo groupdel ${p.group}`);
  }
}

// ---- checking ----------------------------------------------------------------------------
const operands = (e: Entry) => e.argv.filter(a => !a.startsWith('-'));
const at = (e: Entry, p: string) => normpath(isAbs(p) ? p : join(e.cwd0, p));
const homeOf = (c: MissionCtx, user: string) => userBy(c.sys, user)?.home ?? c.home;
const isMember = (c: MissionCtx, group: string, user: string) => !!groupBy(c.sys, group)?.members.includes(user);

export function isDone(m: Mission, c: MissionCtx): boolean {
  const p = m.params;
  const E = c.entries;
  const ran = (pred: (e: Entry) => boolean) => E.some(e => e.rc === 0 && pred(e));
  switch (m.kind) {
    case 'nav-ls-here': return ran(e => e.cmd === 'ls' && operands(e).length === 0);
    case 'nav-ls-dir': return ran(e => e.cmd === 'ls' && operands(e).length === 1 && at(e, operands(e)[0]) === p.dir
      && e.cwd0 !== p.dir && e.cwd1 === e.cwd0);
    case 'nav-cd-dir': return ran(e => e.cmd === 'cd' && operands(e).length === 1 && e.cwd1 === p.dir && e.cwd0 !== p.dir);
    case 'nav-cd-short': return ran(e => e.line.trim() === 'cd' && e.cwd0 !== homeOf(c, e.user) && e.cwd1 === homeOf(c, e.user));
    case 'nav-cd-root-short': return ran(e => e.line.trim() === 'cd /' && e.cwd0 !== '/' && e.cwd1 === '/');
    case 'nav-cd-root-steps': {
      const up = (e: Entry) => e.rc === 0 && /^cd\s+\.\.\/?$/.test(e.line.trim());
      return E.some((e, i) => i > 0 && up(e) && up(E[i - 1]) && e.cwd1 === '/');
    }
    case 'nav-cd-home-abs': return ran(e => e.cmd === 'cd' && e.raw.length === 1 && e.raw[0].replace(/\/$/, '') === homeOf(c, e.user)
      && e.cwd1 === homeOf(c, e.user) && e.cwd0 !== homeOf(c, e.user));
    case 'nav-ls-home-root': return ran(e => e.cmd === 'ls' && e.cwd0 === '/' && operands(e).length === 1
      && at(e, operands(e)[0]) === c.home);
    case 'nav-touch-home': return c.fs.isDir(c.home) && c.fs.list(c.home).some(n => !n.startsWith('.') && c.fs.isFile(join(c.home, n)));
    case 'nav-mv-desktop': return ran(e => e.cmd === 'mv' && e.cwd0 === '/' && operands(e).length >= 2
      && at(e, operands(e)[operands(e).length - 1]).startsWith(c.home + '/Desktop'))
      && c.fs.isDir(c.home + '/Desktop') && c.fs.list(c.home + '/Desktop').some(n => c.fs.isFile(c.home + '/Desktop/' + n));

    case 'usr-useradd': return c.sys.users.some(u => u.via === 'useradd' && u.password === PASSWORD);
    case 'usr-adduser': return added(c).length >= Number(p.n);
    case 'usr-su-whoami': return added(c).filter(u => ran(e => e.cmd === 'whoami' && e.user === u.name)).length >= Number(p.n);
    case 'usr-su-files': return added(c).filter(u => hasFiles(c, u.name, u.home)).length >= Number(p.n);
    case 'usr-nohome': return E.some(e => e.cmd === 'cd' && e.rc !== 0 && userBy(c.sys, e.user)?.via === 'useradd');
    case 'usr-userdel': return ran(e => e.cmd === 'userdel');
    case 'usr-root': {
      const i = E.findIndex(e => e.rc === 0 && e.cmd === 'sudo' && e.raw.includes('-i') && e.user1 === 'root');
      if (i < 0) return false;
      const j = E.findIndex((e, k) => k > i && e.rc === 0 && e.cmd === 'whoami' && e.user === 'root');
      return j > 0 && E.some((e, k) => k > j && e.cmd === 'exit' && e.user === 'root' && e.user1 !== 'root');
    }

    case 'grp-create': return p.names.split(',').every(g => !!groupBy(c.sys, g));
    case 'grp-members': return p.assign.split(';').every(x => {
      const [g, us] = x.split(':');
      return us.split('+').every(u => isMember(c, g, u));
    });
    case 'grp-install': return c.sys.installed.includes('members');
    case 'grp-view': return ran(e => e.cmd === 'groups' && operands(e)[0] === p.user) && ran(e => e.cmd === 'members' && operands(e)[0] === p.group);
    case 'grp-id1': return !!c.cur && c.cur.cmd === 'id' && c.cur.rc === 0 && operands(c.cur)[0] === p.user && isMember(c, p.group, p.user);
    case 'grp-rename': return !groupBy(c.sys, p.from) && isMember(c, p.to, p.user);
    case 'grp-id2': return !!c.cur && c.cur.cmd === 'id' && c.cur.rc === 0 && operands(c.cur)[0] === p.user && isMember(c, p.group, p.user);
    case 'grp-del': return ran(e => e.cmd === 'groupdel' && operands(e)[0] === p.group);
  }
}

/** Users made with adduser that got the agreed password. */
const added = (c: MissionCtx) => c.sys.users.filter(u => u.via === 'adduser' && u.password === PASSWORD);

function hasFiles(c: MissionCtx, user: string, home: string): boolean {
  if (!c.fs.isDir(home)) return false;
  const mine = c.fs.list(home).filter(n => !n.startsWith('.')).map(n => ({ n, node: c.fs.get(join(home, n))! }))
    .filter(x => x.node.owner === user);
  return mine.filter(x => x.node.type === 'file').length >= 2 && mine.some(x => x.node.type === 'dir');
}
