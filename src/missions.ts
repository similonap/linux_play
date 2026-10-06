/**
 * "Missions": things to do besides building the folder structure - navigating
 * the system, managing users and managing groups (lab 3).  A mission is
 * latched as done the moment it is satisfied, so later changes do not undo it.
 */
import { Rng } from './rng';
import { VFS, isAbs, join, normpath } from './vfs';
import { tr } from './i18n';
import { permString } from './commands';
import { System, PASSWORD, PRESET_USERS, groupBy, userBy, nextId } from './world';
import type { Features, Difficulty } from './generator';

export type MissionKind =
  | 'nav-ls-here' | 'nav-ls-dir' | 'nav-cd-dir' | 'nav-cd-short' | 'nav-cd-root-short' | 'nav-cd-root-steps'
  | 'nav-cd-home-abs' | 'nav-ls-home-root' | 'nav-touch-home' | 'nav-mv-desktop'
  | 'usr-useradd' | 'usr-adduser' | 'usr-su-whoami' | 'usr-su-files' | 'usr-nohome' | 'usr-userdel' | 'usr-root'
  | 'grp-create' | 'grp-members' | 'grp-install' | 'grp-view' | 'grp-id1' | 'grp-rename' | 'grp-id2' | 'grp-del'
  | 'p4-adduser' | 'p4-files' | 'p4-exec' | 'p4-dir' | 'p4-lsl' | 'p4-move' | 'p4-chgrp' | 'p4-lsR' | 'p4-fixhome'
  | 'p4-read' | 'p4-sym';

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

const NEW_USERS = ['eva', 'finn', 'gert', 'hanne', 'ivo', 'jana', 'koen', 'lotte'];
const GROUP_NAMES = ['studenten', 'docenten', 'labo', 'team', 'alumni', 'projecten', 'beheer', 'gasten'];
/** File and directory names for the missions: always given, never chosen by the student. */
const NAV_FILES = ['notities.txt', 'todo.txt', 'planning.txt', 'ideeen.txt', 'boodschappen.txt'];
const USER_FILES = ['verslag.txt', 'taken.txt', 'agenda.txt', 'budget.txt', 'adressen.txt'];
const USER_DIRS = ['projecten', 'archief', 'foto', 'muziek'];
const DIRS = ['/etc', '/var/log', '/usr/share', '/var/lib', '/opt', '/usr/bin', '/var/cache'];
/** Lab 4 uses fixed names, exactly like the slides; the permissions and the order differ per exercise. */
const LAB4 = ['lab4a', 'lab4b', 'lab4c'];
/** The user from lab 3 that was made with useradd and has no home directory. */
const NOHOME = 'user1';
/** Where each user's files go in the chown exercise: a -> b -> c -> a, or the other way round. */
const nextOf = (u: string, dir: string) => LAB4[(LAB4.indexOf(u) + (dir === 'prev' ? 2 : 1)) % LAB4.length];
const FILES3 = (u: string) => [1, 2, 3].map(i => `${u}_file${i}`);
/** The owner always gets execute. */
const EXEC_MODES = ['744', '754', '755', '750', '700'];
const DIR_MODES = ['700', '750', '711', '755', '701'];
const WHO = { u: ['the owner', 'de owner'], g: ['the group', 'de group'], o: ['others', 'others'] } as const;
const BITS = { r: ['read', 'lezen', 4], w: ['write', 'schrijven', 2], x: ['execute', 'uitvoeren', 1] } as const;
/** Mode of p4-read file i: only one of u/g/o has the one bit. */
const readMode = (p: Record<string, string>, i: number) =>
  BITS[p.bit as keyof typeof BITS][2] << (8 - 3 * 'ugo'.indexOf(p.order[i]) - 2);
/** Changes for the symbolic exercise, each applied to a new file (644, umask 022). */
export const SYM: { en: string; nl: string; mode: number }[] = [
  { en: 'user only read, group and others nothing', nl: 'user enkel lezen, group en others niets', mode: 0o400 },
  { en: 'user gets execute, group loses read', nl: 'user krijgt execute erbij, group verliest read', mode: 0o704 },
  { en: 'user only read, group only execute, others only write', nl: 'user enkel lezen, group enkel execute, others enkel write', mode: 0o412 },
  { en: 'others lose read', nl: 'others verliezen read', mode: 0o640 },
  { en: 'group gets write', nl: 'group krijgt write erbij', mode: 0o664 },
  { en: 'everyone gets execute', nl: 'iedereen krijgt execute erbij', mode: 0o755 },
  { en: 'user read and write, group and others nothing', nl: 'user lezen en schrijven, group en others niets', mode: 0o600 },
  { en: 'group loses read, others get write', nl: 'group verliest read, others krijgen write erbij', mode: 0o606 },
  { en: 'user loses write, group gets execute', nl: 'user verliest write, group krijgt execute erbij', mode: 0o454 },
  { en: 'user gets execute, others lose read', nl: 'user krijgt execute erbij, others verliezen read', mode: 0o740 },
];
const symOf = (p: Record<string, string>) => p.pick.split(',').map(Number).map(i => SYM[i]);

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
    if (d >= 3) { const file = rng.choice(NAV_FILES); add('nav-ls-home-root'); add('nav-touch-home', { file }); add('nav-mv-desktop', { file }); }
  }
  if (f.users) {
    // every name is given: students forget names they made up themselves
    const [u, ...rest] = rng.sample(NEW_USERS, d === 1 ? 3 : 4);
    const names = rest.join(',');
    add('usr-useradd', { name: u });
    add('usr-adduser', { names });
    add('usr-su-files', { names, files: rng.sample(USER_FILES, 2).join(','), dir: rng.choice(USER_DIRS) });
    if (d >= 2) { add('usr-su-whoami', { names }); add('usr-userdel', { name: rest[0] }); add('usr-root'); }
    if (d >= 3) add('usr-nohome', { name: u });
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
  if (f.rights) {
    add('p4-adduser');
    add('p4-files');
    add('p4-exec', { file: String(rng.int(1, 3)), mode: rng.choice(EXEC_MODES) });
    add('p4-dir', { mode: rng.choice(DIR_MODES) });
    add('p4-lsl');
    if (d >= 2) { add('p4-move', { dir: rng.choice(['next', 'prev']) }); add('p4-chgrp'); add('p4-lsR'); }
    add('p4-read', { order: rng.sample([...'ugo'], 3).join(''), bit: rng.choice(['r', 'r', 'w', 'x']) });
    if (d >= 2) add('p4-sym', { pick: rng.sample(SYM.map((_, i) => i), 3).join(',') });
    if (d >= 3) add('p4-fixhome', { name: NOHOME });
  }
  return out;
}

/** Things some missions need on the machine before the student starts. */
export function setupMissions(missions: Mission[], sys: System): void {
  for (const m of missions) {
    if (m.kind === 'p4-fixhome' && !userBy(sys, m.params.name)) {
      // made with useradd in lab 3: in /etc/passwd, but /home/<name> was never created
      const id = nextId(sys);
      sys.groups.push({ name: m.params.name, gid: id, members: [] });
      sys.users.push({ name: m.params.name, uid: id, gid: id, home: '/home/' + m.params.name, shell: '/bin/sh', password: PASSWORD, via: 'useradd' });
    }
  }
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
    case 'nav-touch-home': return tr(`Create the file ${p.file} in your home directory.`, `Maak het bestand ${p.file} in je home directory.`);
    case 'nav-mv-desktop': return tr(`Standing in /, move ${p.file} from your home directory to the Desktop.`,
      `Verplaats vanuit de root directory / ${p.file} uit je home directory naar de Desktop.`);
    case 'usr-useradd': return tr(`Create the user ${p.name} with useradd and set the password to ${PASSWORD}.`,
      `Creëer de user ${p.name} met useradd en stel het paswoord in op ${PASSWORD}.`);
    case 'usr-adduser': return tr(`Create the users ${list(p.names)} with adduser - password ${PASSWORD} for all of them.`,
      `Creëer de users ${list(p.names)} met adduser - paswoord ${PASSWORD} voor allemaal.`);
    case 'usr-su-whoami': return tr(`Take on the identity of ${list(p.names)} one by one (su) and check with whoami who you are.`,
      `Neem één voor één de identiteit aan van ${list(p.names)} (su) en controleer met whoami wie je bent.`);
    case 'usr-su-files': return tr(`As each of ${list(p.names)}: go to their home directory (check with pwd) and create the files ${list(p.files)} and the directory ${p.dir} there.`,
      `Ga als ${list(p.names)} telkens naar hun home directory (controleer met pwd) en maak daar de bestanden ${list(p.files)} en de directory ${p.dir}.`);
    case 'usr-nohome': return tr(`Take on the identity of ${p.name} (made with useradd) and try cd /home/${p.name}. What do you notice?`,
      `Neem de identiteit aan van ${p.name} (gemaakt met useradd) en probeer cd /home/${p.name}. Wat merk je?`);
    case 'usr-userdel': return tr(`Remove the user ${p.name} again with userdel.`, `Verwijder de user ${p.name} terug met userdel.`);
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

    case 'p4-adduser': return tr(`Create the users ${LAB4.join(', ')} with adduser (password ${PASSWORD}).`,
      `Maak de users ${LAB4.join(', ')} aan met adduser (paswoord ${PASSWORD}).`);
    case 'p4-files': return tr('Log in as each of them with su and create in their own home directory: lab4x_file1, lab4x_file2, lab4x_file3 and the directory lab4x_dir (x = a, b or c).',
      'Meld je met su aan als elk van hen en maak in hun eigen home directory: lab4x_file1, lab4x_file2, lab4x_file3 en de directory lab4x_dir (x = a, b of c).');
    case 'p4-exec': { const m = permString(parseInt(p.mode, 8));
      return tr(`For each user: give lab4x_file${p.file} the permissions ${m} - the owner gets execute (numeric notation).`,
        `Voor elke user: geef lab4x_file${p.file} de rechten ${m} - de owner krijgt execute (numerieke notatie).`); }
    case 'p4-dir': { const m = permString(parseInt(p.mode, 8));
      return tr(`For each user: give lab4x_dir the permissions ${m} (numeric notation).`,
        `Voor elke user: geef lab4x_dir de rechten ${m} (numerieke notatie).`); }
    case 'p4-lsl': return tr('Check the permissions of each user with ls -l or ll.', 'Controleer de rechten bij elke user met ls -l of ll.');
    case 'p4-move': { const [a, b, c] = LAB4.map(u => nextOf(u, p.dir));
      return tr(`Move the files: those of lab4a to the home directory of ${a}, those of lab4b to ${b}, those of lab4c to ${c}.`,
        `Verplaats de files: die van lab4a naar de home directory van ${a}, die van lab4b naar ${b}, die van lab4c naar ${c}.`); }
    case 'p4-chgrp': return tr('In every lab4 home directory: change the group of one of the moved files to the group of the user who lives there.',
      'In elke lab4-home directory: verander de groep van één van de verhuisde files naar de groep van de user die daar woont.');
    case 'p4-lsR': return tr('Go to /home and run ls -l -R lab4* (mind the asterisk).', 'Ga naar /home en geef het commando ls -l -R lab4* (let op het sterretje).');
    case 'p4-fixhome': return tr(`The user ${p.name} was made with useradd and has no home directory. Give ${p.name} a correct home directory, with the right user and group ownership.`,
      `De user ${p.name} werd met useradd gemaakt en heeft geen home directory. Geef ${p.name} een correcte home directory, met de juiste user- en group-ownership.`);
    case 'p4-read': {
      const [en, nl] = BITS[p.bit as keyof typeof BITS];
      const who = (i: number, l: 0 | 1) => WHO[p.order[i] as keyof typeof WHO][l];
      return tr(`In your own home directory, make the directory linux-labo4 with lab4a_file1 … lab4c_file3 (9 files). Numeric notation, nobody else gets anything: file1 → only ${who(0, 0)} may ${en}, file2 → only ${who(1, 0)}, file3 → only ${who(2, 0)}.`,
        `Maak in je eigen home directory de directory linux-labo4 met lab4a_file1 … lab4c_file3 (9 files). Numerieke notatie, niemand anders krijgt iets: file1 → enkel ${who(0, 1)} mag ${nl}, file2 → enkel ${who(1, 1)}, file3 → enkel ${who(2, 1)}.`);
    }
    case 'p4-sym': { const x = symOf(p);
      return tr(`Make ~/linux-labo4/oef3 with file1, file2, file3. Letters only (+/-), starting from a new file: file1 → ${x[0].en}; file2 → ${x[1].en}; file3 → ${x[2].en}.`,
        `Maak ~/linux-labo4/oef3 met file1, file2, file3. Enkel letters (+/-), vertrekkend van een nieuwe file: file1 → ${x[0].nl}; file2 → ${x[1].nl}; file3 → ${x[2].nl}.`); }
  }
}

const list = (names: string) => names.split(',').join(', ');
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
    case 'nav-touch-home': return tr(`touch ~/${p.file} (or go home first).`, `touch ~/${p.file} (of ga eerst naar huis).`);
    case 'nav-mv-desktop': return tr(`cd / first, then mv home/student/${p.file} home/student/Desktop.`, `Doe eerst cd / en dan mv home/student/${p.file} home/student/Desktop.`);
    case 'usr-useradd': return tr(`sudo useradd ${p.name}  then  sudo passwd ${p.name}`, `sudo useradd ${p.name}  daarna  sudo passwd ${p.name}`);
    case 'usr-adduser': return tr('sudo adduser <name> (it asks for the password itself).', 'sudo adduser <naam> (het vraagt zelf om het paswoord).');
    case 'usr-su-whoami': return tr('su <name>, then whoami; exit brings you back.', 'su <naam>, dan whoami; met exit kom je terug.');
    case 'usr-su-files': return tr(`su <name>, cd ~ (or cd /home/<name>), touch ${p.files.split(',').join(' ')}, mkdir ${p.dir}, exit.`,
      `su <naam>, cd ~ (of cd /home/<naam>), touch ${p.files.split(',').join(' ')}, mkdir ${p.dir}, exit.`);
    case 'usr-nohome': return tr(`su ${p.name}, then cd /home/${p.name}. useradd does not create a home directory (unless you give -m).`,
      `su ${p.name}, dan cd /home/${p.name}. useradd maakt geen home directory aan (tenzij je -m meegeeft).`);
    case 'usr-userdel': return tr(`sudo userdel ${p.name} (add -r to remove the home directory too).`, `sudo userdel ${p.name} (met -r verdwijnt ook de home directory).`);
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

    case 'p4-adduser': return tr('sudo adduser lab4a (and the same for lab4b and lab4c).', 'sudo adduser lab4a (en hetzelfde voor lab4b en lab4c).');
    case 'p4-files': return tr('su lab4a, cd ~, touch lab4a_file1 lab4a_file2 lab4a_file3, mkdir lab4a_dir, exit - then b and c.',
      'su lab4a, cd ~, touch lab4a_file1 lab4a_file2 lab4a_file3, mkdir lab4a_dir, exit - dan b en c.');
    case 'p4-exec': return tr('r = 4, w = 2, x = 1, added up per group of three (owner, group, others): rwx = 7, r-x = 5, r-- = 4, --- = 0.',
      'r = 4, w = 2, x = 1, opgeteld per groepje van drie (owner, group, others): rwx = 7, r-x = 5, r-- = 4, --- = 0.');
    case 'p4-dir': return tr('Three digits: owner, group, others. rwx = 4+2+1 = 7, --x = 1, --- = 0.', 'Drie cijfers: owner, group, others. rwx = 4+2+1 = 7, --x = 1, --- = 0.');
    case 'p4-lsl': return tr('As the user (or with a path): ls -l /home/lab4a', 'Als de user (of met een pad): ls -l /home/lab4a');
    case 'p4-move': return tr(`You cannot write in somebody else's home: sudo mv /home/lab4a/lab4a_file* /home/${nextOf('lab4a', p.dir)}`,
      `Je mag niet schrijven in de home van iemand anders: sudo mv /home/lab4a/lab4a_file* /home/${nextOf('lab4a', p.dir)}`);
    case 'p4-chgrp': return tr('chown :group file changes only the group (the file is not yours: sudo).', 'chown :groep file verandert enkel de groep (de file is niet van jou: sudo).');
    case 'p4-lsR': return tr('cd /home, then ls -l -R lab4*', 'cd /home, dan ls -l -R lab4*');
    case 'p4-fixhome': return tr(`sudo mkdir /home/${p.name}, then sudo chown ${p.name}:${p.name} /home/${p.name}`,
      `sudo mkdir /home/${p.name}, dan sudo chown ${p.name}:${p.name} /home/${p.name}`);
    case 'p4-read': return tr('r = 4, w = 2, x = 1. Owner, group, others - in that order: e.g. only the group may write = 020.',
      'r = 4, w = 2, x = 1. Owner, group, others - in die volgorde: bv. enkel de group mag schrijven = 020.');
    case 'p4-sym': return tr('u, g, o with + or -, e.g. chmod u+x,g-w file2. Several in one go with commas.',
      'u, g, o met + of -, bv. chmod u+x,g-w file2. Meerdere tegelijk met komma\'s.');
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
    case 'nav-touch-home': return c.fs.isFile(join(c.home, p.file));
    case 'nav-mv-desktop': return ran(e => e.cmd === 'mv' && e.cwd0 === '/' && operands(e).length >= 2
      && at(e, operands(e)[operands(e).length - 1]).startsWith(c.home + '/Desktop'))
      && c.fs.isFile(join(c.home, 'Desktop/' + p.file)) && !c.fs.exists(join(c.home, p.file));

    case 'usr-useradd': { const u = userBy(c.sys, p.name); return !!u && u.via === 'useradd' && u.password === PASSWORD; }
    case 'usr-adduser': return p.names.split(',').every(n => { const u = userBy(c.sys, n); return !!u && u.via === 'adduser' && u.password === PASSWORD; });
    case 'usr-su-whoami': return p.names.split(',').every(n => ran(e => e.cmd === 'whoami' && e.user === n));
    case 'usr-su-files': return p.names.split(',').every(n => {
      const h = userBy(c.sys, n)?.home;
      return !!h && p.files.split(',').every(f => owned(c, join(h, f), n, 'file')) && owned(c, join(h, p.dir), n, 'dir');
    });
    case 'usr-nohome': return E.some(e => e.user === p.name && e.cmd === 'cd' && e.rc !== 0);
    case 'usr-userdel': return ran(e => e.cmd === 'userdel' && operands(e)[0] === p.name);
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

    case 'p4-adduser': return LAB4.every(u => userBy(c.sys, u)?.via === 'adduser');
    case 'p4-files': return LAB4.every(u => {
      const h = homeOf(c, u);
      return FILES3(u).every(f => owned(c, join(h, f), u, 'file')) && owned(c, join(h, `${u}_dir`), u, 'dir');
    });
    case 'p4-exec': return LAB4.every(u => {
      const n = c.fs.get(join(homeOf(c, u), `${u}_file${p.file}`));
      return n?.type === 'file' && (n.mode & 0o777) === parseInt(p.mode, 8) && n.how === 'num';
    });
    case 'p4-dir': return LAB4.every(u => {
      const n = c.fs.get(join(homeOf(c, u), `${u}_dir`));
      return n?.type === 'dir' && (n.mode & 0o777) === parseInt(p.mode, 8) && n.how === 'num';
    });
    case 'p4-lsl': return LAB4.every(u => ran(e => {
      const long = e.cmd === 'll' || (e.cmd === 'ls' && e.argv.some(a => /^-[a-zA-Z]*l/.test(a)));
      const h = homeOf(c, u);
      return long && [e.cwd0, ...operands(e).map(o => at(e, o))].some(x => x === h || x.startsWith(h + '/'));
    }));
    case 'p4-move': return LAB4.every(u => FILES3(u).every(f =>
      c.fs.isFile(join(homeOf(c, nextOf(u, p.dir)), f)) && !c.fs.exists(join(homeOf(c, u), f))));
    case 'p4-chgrp': return LAB4.every(y => {
      const h = homeOf(c, y);
      return c.fs.isDir(h) && c.fs.list(h).some(n => { const x = c.fs.get(join(h, n))!; return x.type === 'file' && x.owner !== y && x.group === y; });
    });
    // no rc check: as a normal user ls stops at the closed lab4x_dir directories, just like on a real machine
    case 'p4-lsR': return E.some(e => e.cmd === 'ls' && e.cwd0 === '/home' && e.raw.includes('lab4*')
      && ['l', 'R'].every(f => e.raw.some(a => /^-[a-zA-Z]+$/.test(a) && a.includes(f))));
    case 'p4-fixhome': {
      const u = userBy(c.sys, p.name);
      const n = u && c.fs.get(u.home);
      return !!n && n.type === 'dir' && n.owner === p.name && n.group === p.name;
    }
    case 'p4-read': return LAB4.every(u => FILES3(u).every((f, i) => {
      const n = c.fs.get(join(c.home, 'linux-labo4/' + f));
      return n?.type === 'file' && (n.mode & 0o777) === readMode(p, i) && n.how === 'num';
    }));
    case 'p4-sym': {
      return symOf(p).map(x => x.mode).every((m, i) => {
        const n = c.fs.get(join(c.home, `linux-labo4/oef3/file${i + 1}`));
        return n?.type === 'file' && (n.mode & 0o777) === m && n.how === 'sym';
      });
    }
  }
}

/** Is `path` a file/dir owned by `user`? */
function owned(c: MissionCtx, path: string, user: string, type: 'file' | 'dir'): boolean {
  const n = c.fs.get(path);
  return n?.type === type && n.owner === user;
}
