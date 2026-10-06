/**
 * User and group administration commands (useradd, adduser, passwd, userdel,
 * groupadd, groupdel, groupmod, usermod) and the small info commands (id,
 * groups, members, whoami, apt).  Output follows the real tools; the text is
 * English like the rest of the command output.
 */
import { VFS } from './vfs';
import {
  System, User, EXTRA_GROUPS, groupBy, groupById, groupsOf, makeHome, nextId, userBy,
} from './world';

export interface AdminEnv {
  sys: System;
  fs: VFS;
  /** the user the command runs as (root when called through sudo) */
  actor: string;
  /** everybody who is logged in through su / sudo -i, so userdel can refuse */
  loggedIn: string[];
  print: (s?: string) => void;
  /** ask a question; `secret` hides what is typed */
  ask: (prompt: string, secret: boolean, cb: (answer: string) => void) => void;
}
export type Done = (rc: number) => void;
type Cmd = (env: AdminEnv, args: string[], done: Done) => void;

const NAME = /^[a-z_][a-z0-9_-]*$/;
const lockMsg = (e: AdminEnv, cmd: string, file: string, done: Done) => {
  e.print(`${cmd}: Permission denied.`);
  e.print(`${cmd}: cannot lock ${file}; try again later.`);
  done(1);
};

/** Split off options; `withArg` options take the next word (or the rest of the word). */
function parse(args: string[], withArg: string): { flags: Map<string, string | true>; ops: string[]; bad?: string } {
  const flags = new Map<string, string | true>();
  const ops: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { ops.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const [k, v] = a.slice(2).split('=');
      flags.set(k, v ?? true);
    } else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (withArg.includes(ch)) {
          const rest = a.slice(j + 1);
          if (rest) flags.set(ch, rest); else if (i + 1 < args.length) flags.set(ch, args[++i]); else return { flags, ops, bad: ch };
          break;
        }
        flags.set(ch, true);
      }
    } else ops.push(a);
  }
  return { flags, ops };
}

const addMember = (sys: System, group: string, user: string) => {
  const g = groupBy(sys, group);
  if (g && !g.members.includes(user)) g.members.push(user);
};

function createUser(e: AdminEnv, name: string, via: User['via'], opts: { home?: string; shell?: string; gid?: number } = {}): User {
  const id = nextId(e.sys);
  let gid = opts.gid;
  if (gid === undefined) { e.sys.groups.push({ name, gid: id, members: [] }); gid = id; }
  const u: User = { name, uid: id, gid, home: opts.home ?? '/home/' + name, shell: opts.shell ?? '/bin/bash', password: null, via };
  e.sys.users.push(u);
  return u;
}

const useradd: Cmd = (e, args, done) => {
  const { flags, ops, bad } = parse(args, 'dsGgcu');
  if (bad) { e.print(`useradd: option requires an argument -- '${bad}'`); return done(2); }
  const known = new Set(['m', 'd', 's', 'G', 'g', 'c', 'u', 'r', 'create-home', 'M', 'N']);
  for (const k of flags.keys()) if (!known.has(k)) { e.print(`useradd: invalid option -- '${k}'`); return done(2); }
  if (ops.length !== 1) { e.print('Usage: useradd [options] LOGIN'); return done(2); }
  if (e.actor !== 'root') return lockMsg(e, 'useradd', '/etc/passwd', done);
  const name = ops[0];
  if (!NAME.test(name)) { e.print(`useradd: invalid user name '${name}'`); return done(3); }
  if (userBy(e.sys, name)) { e.print(`useradd: user '${name}' already exists`); return done(9); }
  let gid: number | undefined;
  if (typeof flags.get('g') === 'string') {
    const g = groupBy(e.sys, flags.get('g') as string);
    if (!g) { e.print(`useradd: group '${flags.get('g')}' does not exist`); return done(6); }
    gid = g.gid;
  } else if (groupBy(e.sys, name)) {
    e.print(`useradd: group ${name} exists - if you want to add this user to that group, use -g.`);
    return done(9);
  }
  const extra = typeof flags.get('G') === 'string' ? (flags.get('G') as string).split(',').filter(Boolean) : [];
  for (const g of extra) if (!groupBy(e.sys, g)) { e.print(`useradd: group '${g}' does not exist`); return done(6); }
  const u = createUser(e, name, 'useradd', {
    home: typeof flags.get('d') === 'string' ? flags.get('d') as string : undefined,
    shell: typeof flags.get('s') === 'string' ? flags.get('s') as string : undefined, gid,
  });
  for (const g of extra) addMember(e.sys, g, name);
  if (flags.has('m') || flags.has('create-home')) makeHome(e.fs, u);   // without -m there is no home directory!
  done(0);
};

const adduser: Cmd = (e, args, done) => {
  const ops = args.filter(a => !a.startsWith('-'));
  if (args.some(a => a.startsWith('-'))) { e.print('adduser: this option is not available in the lab'); return done(1); }
  if (e.actor !== 'root') { e.print('adduser: Only root may add a user or group to the system.'); return done(1); }
  if (ops.length === 0) { e.print('adduser: Only one or two names allowed.'); return done(1); }
  if (ops.length === 2) {            // adduser USER GROUP
    const [user, group] = ops;
    if (!userBy(e.sys, user)) { e.print(`The user \`${user}' does not exist.`); return done(1); }
    if (!groupBy(e.sys, group)) { e.print(`The group \`${group}' does not exist.`); return done(1); }
    e.print(`Adding user \`${user}' to group \`${group}' ...`);
    addMember(e.sys, group, user);
    e.print('Done.');
    return done(0);
  }
  const name = ops[0];
  if (ops.length > 2) { e.print('adduser: Only one or two names allowed.'); return done(1); }
  if (!NAME.test(name)) {
    e.print(`adduser: To avoid problems, the username should consist only of letters, digits, underscores, periods, at signs and dashes.`);
    return done(1);
  }
  if (userBy(e.sys, name)) { e.print(`adduser: The user \`${name}' already exists.`); return done(1); }
  if (groupBy(e.sys, name)) { e.print(`adduser: The group \`${name}' already exists.`); return done(1); }

  const id = nextId(e.sys);
  e.print(`Adding user \`${name}' ...`);
  e.print(`Adding new group \`${name}' (${id}) ...`);
  e.print(`Adding new user \`${name}' (${id}) with group \`${name}' ...`);
  e.print(`Creating home directory \`/home/${name}' ...`);
  e.print("Copying files from `/etc/skel' ...");
  const u = createUser(e, name, 'adduser');
  makeHome(e.fs, u);
  for (const g of EXTRA_GROUPS) addMember(e.sys, g, name);

  const info = (fields: string[], i: number) => {
    if (i < fields.length) return e.ask(`\t${fields[i]} []: `.replace('\t', '        '), false, () => info(fields, i + 1));
    e.ask('Is the information correct? [Y/n] ', false, () => done(0));
  };
  const askPassword = () => e.ask('New password: ', true, p1 => e.ask('Retype new password: ', true, p2 => {
    if (p1 === '' || p1 !== p2) {
      e.print(p1 === '' ? 'No password has been supplied.' : 'Sorry, passwords do not match.');
      e.print('passwd: Authentication token manipulation error');
      e.print('passwd: password unchanged');
      return e.ask('Try again? [y/N] ', false, a => {
        if (/^y/i.test(a)) return askPassword();
        e.print(`adduser: \`/usr/bin/passwd ${name}' returned error code 10. Exiting.`);
        done(1);
      });
    }
    u.password = p1;
    e.print('passwd: password updated successfully');
    e.print(`Changing the user information for ${name}`);
    e.print('Enter the new value, or press ENTER for the default');
    info(['Full Name', 'Room Number', 'Work Phone', 'Home Phone', 'Other'], 0);
  }));
  askPassword();
};

const passwd: Cmd = (e, args, done) => {
  const ops = args.filter(a => !a.startsWith('-'));
  const target = ops[0] ?? e.actor;
  const self = target === e.actor;
  if (!self && e.actor !== 'root') {
    e.print(`passwd: You may not view or modify password information for ${target}.`);
    return done(1);
  }
  const u = userBy(e.sys, target);
  if (!u) { e.print(`passwd: user '${target}' does not exist`); return done(1); }
  const fail = (msg: string) => { e.print(msg); e.print('passwd: Authentication token manipulation error'); e.print('passwd: password unchanged'); done(10); };
  const setNew = () => e.ask('New password: ', true, p1 => e.ask('Retype new password: ', true, p2 => {
    if (p1 !== p2) return fail('Sorry, passwords do not match.');
    if (p1 === '') return fail('No password has been supplied.');
    u.password = p1;
    e.print('passwd: password updated successfully');
    done(0);
  }));
  if (e.actor === 'root') return setNew();
  e.print(`Changing password for ${target}.`);
  e.ask('Current password: ', true, cur => {
    if (cur !== u.password) {
      e.print('passwd: Authentication token manipulation error');
      e.print('passwd: password unchanged');
      return done(10);
    }
    setNew();
  });
};

const userdel: Cmd = (e, args, done) => {
  const { flags, ops } = parse(args, '');
  if (ops.length !== 1) { e.print('Usage: userdel [options] LOGIN'); return done(2); }
  if (e.actor !== 'root') return lockMsg(e, 'userdel', '/etc/passwd', done);
  const name = ops[0];
  const u = userBy(e.sys, name);
  if (!u) { e.print(`userdel: user '${name}' does not exist`); return done(6); }
  if (e.loggedIn.includes(name)) { e.print(`userdel: user ${name} is currently used by process 1`); return done(8); }
  e.sys.users = e.sys.users.filter(x => x !== u);
  for (const g of e.sys.groups) g.members = g.members.filter(m => m !== name);
  const pg = groupById(e.sys, u.gid);
  if (pg && pg.name === name && !e.sys.users.some(x => x.gid === pg.gid)) e.sys.groups = e.sys.groups.filter(g => g !== pg);
  if ((flags.has('r') || flags.has('remove')) && e.fs.isDir(u.home)) e.fs.rmtree(u.home);
  done(0);
};

const groupadd: Cmd = (e, args, done) => {
  const { ops } = parse(args, 'g');
  if (ops.length !== 1) { e.print('Usage: groupadd [options] GROUP'); return done(2); }
  if (e.actor !== 'root') return lockMsg(e, 'groupadd', '/etc/group', done);
  const name = ops[0];
  if (!NAME.test(name)) { e.print(`groupadd: '${name}' is not a valid group name`); return done(3); }
  if (groupBy(e.sys, name)) { e.print(`groupadd: group '${name}' already exists`); return done(9); }
  e.sys.groups.push({ name, gid: nextId(e.sys), members: [] });
  done(0);
};

const groupdel: Cmd = (e, args, done) => {
  const { ops } = parse(args, '');
  if (ops.length !== 1) { e.print('Usage: groupdel [options] GROUP'); return done(2); }
  if (e.actor !== 'root') return lockMsg(e, 'groupdel', '/etc/group', done);
  const g = groupBy(e.sys, ops[0]);
  if (!g) { e.print(`groupdel: group '${ops[0]}' does not exist`); return done(6); }
  const owner = e.sys.users.find(u => u.gid === g.gid);
  if (owner) { e.print(`groupdel: cannot remove the primary group of user '${owner.name}'`); return done(8); }
  e.sys.groups = e.sys.groups.filter(x => x !== g);
  done(0);
};

const groupmod: Cmd = (e, args, done) => {
  const { flags, ops, bad } = parse(args, 'ng');
  if (bad || !flags.has('n') || ops.length !== 1) { e.print('Usage: groupmod -n NEW_GROUP GROUP'); return done(2); }
  if (e.actor !== 'root') return lockMsg(e, 'groupmod', '/etc/group', done);
  const oldName = ops[0];
  const newName = flags.get('n') as string;
  const g = groupBy(e.sys, oldName);
  if (!g) { e.print(`groupmod: group '${oldName}' does not exist`); return done(6); }
  if (groupBy(e.sys, newName)) { e.print(`groupmod: group '${newName}' already exists`); return done(9); }
  g.name = newName;
  for (const p of ['/', ...e.fs.descendants('/')]) {      // files keep belonging to the renamed group
    const n = e.fs.get(p);
    if (n && n.group === oldName) n.group = newName;
  }
  done(0);
};

const usermod: Cmd = (e, args, done) => {
  const { flags, ops, bad } = parse(args, 'Gg');
  const supported = new Set(['a', 'G', 'g', 'append', 'groups']);
  for (const k of flags.keys()) if (!supported.has(k)) { e.print('usermod: this option is not available in the lab (use -a -G group user)'); return done(2); }
  if (bad || ops.length !== 1 || !(flags.has('G') || flags.has('g'))) {
    e.print(bad ? `usermod: option requires an argument -- '${bad}'` : 'Usage: usermod [options] LOGIN');
    return done(2);
  }
  if (flags.has('a') && !flags.has('G')) { e.print('usermod: option -a requires -G'); return done(2); }
  if (e.actor !== 'root') return lockMsg(e, 'usermod', '/etc/passwd', done);
  const u = userBy(e.sys, ops[0]);
  if (!u) { e.print(`usermod: user '${ops[0]}' does not exist`); return done(6); }
  const list = flags.has('G') ? (flags.get('G') as string).split(',').filter(Boolean) : [];
  for (const g of list) if (!groupBy(e.sys, g)) { e.print(`usermod: group '${g}' does not exist`); return done(6); }
  if (flags.has('g')) {
    const pg = groupBy(e.sys, flags.get('g') as string);
    if (!pg) { e.print(`usermod: group '${flags.get('g')}' does not exist`); return done(6); }
    u.gid = pg.gid;
  }
  if (flags.has('G')) {
    if (!flags.has('a')) for (const g of e.sys.groups) g.members = g.members.filter(m => m !== u.name);
    for (const g of list) addMember(e.sys, g, u.name);
  }
  done(0);
};

const groupNames = (e: AdminEnv, name: string) => groupsOf(e.sys, name).map(g => g.name);

const groups: Cmd = (e, args, done) => {
  if (!args.length) { e.print(groupNames(e, e.actor).join(' ')); return done(0); }
  let rc = 0;
  for (const a of args) {
    if (!userBy(e.sys, a)) { e.print(`groups: ‘${a}’: no such user`); rc = 1; continue; }
    e.print(`${a} : ${groupNames(e, a).join(' ')}`);
  }
  done(rc);
};

const id: Cmd = (e, args, done) => {
  const { flags, ops } = parse(args, '');
  const name = ops[0] ?? e.actor;
  const u = userBy(e.sys, name);
  if (!u) { e.print(`id: ‘${name}’: no such user`); return done(1); }
  const gs = groupsOf(e.sys, name);
  const pg = groupById(e.sys, u.gid);
  const named = flags.has('n');
  if (flags.has('u')) e.print(named ? u.name : String(u.uid));
  else if (flags.has('g')) e.print(named ? (pg?.name ?? String(u.gid)) : String(u.gid));
  else if (flags.has('G')) e.print(gs.map(g => (named ? g.name : String(g.gid))).join(' '));
  else {
    e.print(`uid=${u.uid}(${u.name}) gid=${u.gid}(${pg?.name ?? ''}) groups=${gs.map(g => `${g.gid}(${g.name})`).join(',')}`);
  }
  done(0);
};

const members: Cmd = (e, args, done) => {
  if (!e.sys.installed.includes('members')) { e.print('members: command not found'); return done(127); }
  if (args.length !== 1) { e.print('Usage: members GROUP'); return done(1); }
  const g = groupBy(e.sys, args[0]);
  if (!g) { e.print(`members: group \`${args[0]}' not found`); return done(1); }
  const primary = e.sys.users.filter(u => u.gid === g.gid).map(u => u.name);
  e.print([...new Set([...g.members, ...primary])].join(' '));
  done(0);
};

const whoami: Cmd = (e, _args, done) => { e.print(e.actor); done(0); };

const apt: Cmd = (e, args, done) => {
  const ops = args.filter(a => !a.startsWith('-'));
  if (ops[0] === 'update') {
    if (e.actor !== 'root') { e.print('E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)'); return done(100); }
    e.print('Reading package lists... Done');
    return done(0);
  }
  if (ops[0] !== 'install' || ops.length < 2) { e.print('apt: in the lab only `apt install members` is available'); return done(1); }
  if (e.actor !== 'root') {
    e.print('E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)');
    e.print('E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?');
    return done(100);
  }
  const pkg = ops[1];
  if (pkg !== 'members') { e.print(`E: Unable to locate package ${pkg}`); return done(100); }
  if (e.sys.installed.includes('members')) {
    e.print('Reading package lists... Done');
    e.print('Building dependency tree... Done');
    e.print('members is already the newest version (20080128-5+b1).');
    e.print('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.');
    return done(0);
  }
  for (const l of [
    'Reading package lists... Done', 'Building dependency tree... Done', 'Reading state information... Done',
    'The following NEW packages will be installed:', '  members',
    '0 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.', 'Need to get 8,404 B of archives.',
    'After this operation, 41.0 kB of additional disk space will be used.',
    'Get:1 http://archive.ubuntu.com/ubuntu jammy/universe amd64 members amd64 20080128-5+b1 [8,404 B]',
    'Fetched 8,404 B in 0s (51.3 kB/s)', 'Selecting previously unselected package members.',
    'Preparing to unpack .../members_20080128-5+b1_amd64.deb ...', 'Unpacking members (20080128-5+b1) ...',
    'Setting up members (20080128-5+b1) ...',
  ]) e.print(l);
  e.sys.installed.push('members');
  done(0);
};

export const ADMIN: Record<string, Cmd> = {
  useradd, adduser, passwd, userdel, groupadd, groupdel, groupmod, usermod, groups, id, members, whoami, apt,
};
