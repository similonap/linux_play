/**
 * The simulated machine around the exercise: users, groups and a realistic
 * directory tree (/etc, /var/log, /home, ...).
 */
import { VFS } from './vfs';

export interface User {
  name: string; uid: number; gid: number; home: string; shell: string;
  /** null = locked (no password set yet) */
  password: string | null;
  via: 'system' | 'useradd' | 'adduser';
}
export interface Group { name: string; gid: number; members: string[] }
export interface System { users: User[]; groups: Group[]; installed: string[]; hostname: string }

export const PASSWORD = 'labolinux';
/** Regular users that exist from the start, next to `student`. */
export const PRESET_USERS = ['anna', 'bram', 'carlo', 'dries'];
/** Groups adduser puts a new user in (like on a desktop Linux). */
export const EXTRA_GROUPS = ['cdrom', 'floppy', 'audio', 'video', 'plugdev', 'users'];

const SYSTEM_GROUPS: [string, number][] = [
  ['root', 0], ['daemon', 1], ['bin', 2], ['sys', 3], ['adm', 4], ['tty', 5], ['disk', 6], ['lp', 7], ['mail', 8],
  ['news', 9], ['uucp', 10], ['man', 12], ['proxy', 13], ['kmem', 15], ['dialout', 20], ['fax', 21], ['voice', 22],
  ['cdrom', 24], ['floppy', 25], ['tape', 26], ['sudo', 27], ['audio', 29], ['dip', 30], ['www-data', 33],
  ['backup', 34], ['operator', 37], ['list', 38], ['irc', 39], ['src', 40], ['shadow', 42], ['utmp', 43],
  ['video', 44], ['sasl', 45], ['plugdev', 46], ['staff', 50], ['games', 60], ['users', 100], ['nogroup', 65534],
];

export function initialSystem(): System {
  const groups: Group[] = SYSTEM_GROUPS.map(([name, gid]) => ({ name, gid, members: [] }));
  const users: User[] = [{ name: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/bash', password: PASSWORD, via: 'system' }];
  const sys: System = { users, groups, installed: [], hostname: 'lab' };
  const addMember = (g: string, u: string) => groupBy(sys, g)!.members.push(u);
  for (const name of ['student', ...PRESET_USERS]) {
    const id = nextId(sys);
    groups.push({ name, gid: id, members: [] });
    users.push({ name, uid: id, gid: id, home: '/home/' + name, shell: '/bin/bash', password: PASSWORD, via: 'system' });
  }
  for (const g of ['sudo', ...EXTRA_GROUPS]) addMember(g, 'student');
  for (const g of ['audio', 'video', 'users']) for (const u of PRESET_USERS) addMember(g, u);
  return sys;
}

// ---- lookups -----------------------------------------------------------------------
export const userBy = (s: System, name: string) => s.users.find(u => u.name === name);
export const groupBy = (s: System, name: string) => s.groups.find(g => g.name === name);
export const groupById = (s: System, gid: number) => s.groups.find(g => g.gid === gid);

/** Primary group first, then the other groups the user is a member of. */
export function groupsOf(s: System, name: string): Group[] {
  const u = userBy(s, name);
  if (!u) return [];
  const primary = groupById(s, u.gid);
  const rest = s.groups.filter(g => g.members.includes(name) && g !== primary).sort((a, b) => a.gid - b.gid);
  return primary ? [primary, ...rest] : rest;
}

/** The next free uid/gid from 1000 up (like adduser does). */
export function nextId(s: System): number {
  let id = 1000;
  while (s.users.some(u => u.uid === id) || s.groups.some(g => g.gid === id)) id++;
  return id;
}

export const isSudoer = (s: System, name: string) => name === 'root' || !!groupBy(s, 'sudo')?.members.includes(name);

// ---- the directory tree ---------------------------------------------------------------
type Tree = { [name: string]: Tree | string };

const FILES: Tree = {
  bin: { ls: '', cp: '', mv: '', rm: '', mkdir: '', cat: '', bash: '', grep: '', touch: '', pwd: '' },
  boot: { vmlinuz: '', initrd: '', grub: {} },
  dev: { null: '', zero: '', tty: '', random: '' },
  etc: {
    passwd: 'root:x:0:0:root:/root:/bin/bash\n', group: 'root:x:0:\n', shadow: '', hostname: 'lab\n',
    hosts: '127.0.0.1 localhost\n', fstab: '', issue: 'Linux Lab\n', 'os-release': 'NAME="Linux Lab"\n',
    'resolv.conf': '', sudoers: '', 'adduser.conf': '', 'login.defs': '',
    apt: { 'sources.list': '', 'sources.list.d': {} }, ssh: { ssh_config: '', sshd_config: '' },
    skel: { '.bashrc': '', '.profile': '', '.bash_logout': '' }, network: { interfaces: '' },
    default: {}, cron: {}, systemd: {},
  },
  lib: { modules: {} },
  media: {}, mnt: {}, opt: {},
  proc: {}, run: {}, sbin: { useradd: '', userdel: '', groupadd: '', usermod: '' }, srv: {}, sys: {},
  tmp: {},
  usr: { bin: { python3: '', vim: '', nano: '', sudo: '', id: '', whoami: '' }, lib: {}, local: { bin: {}, share: {} },
    share: { doc: {}, man: {}, zoneinfo: {} }, include: {}, src: {} },
  var: {
    log: { syslog: '', 'auth.log': '', 'dpkg.log': '', 'kern.log': '', 'boot.log': '', apt: {} },
    lib: { dpkg: {}, apt: {} }, cache: { apt: {} }, tmp: {}, mail: {}, spool: {}, www: {},
  },
};

const HOME_DIRS = ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos'];

/** Build the whole machine: the system tree plus a home directory for every regular user. */
export function buildWorld(sys: System): VFS {
  const fs = new VFS();
  const put = (base: string, tree: Tree) => {
    for (const [name, v] of Object.entries(tree)) {
      const p = base === '/' ? '/' + name : base + '/' + name;
      if (typeof v === 'string') fs.writeFile(p, v);
      else { fs.mkdir(p); put(p, v); }
    }
  };
  put('/', FILES);
  fs.setMeta('/etc/shadow', { group: 'shadow', mode: 0o640 });
  fs.setMeta('/etc/sudoers', { mode: 0o440 });
  fs.setMeta('/tmp', { mode: 0o1777 });
  fs.setMeta('/var/tmp', { mode: 0o1777 });
  fs.mkdir('/root');
  fs.setMeta('/root', { mode: 0o700 });
  fs.writeFile('/root/.bashrc', '');
  fs.mkdir('/home');
  for (const u of sys.users) if (u.uid >= 1000 && u.uid < 60000) makeHome(fs, u, HOME_DIRS);
  return fs;
}

/** Create a home directory owned by the user (and fill it like /etc/skel). */
export function makeHome(fs: VFS, u: User, dirs: string[] = []): void {
  const prev = fs.actor;
  fs.actor = { user: u.name, groups: [u.name], group: u.name };
  fs.mkdirp(u.home);
  for (const f of ['.bashrc', '.profile', '.bash_logout']) fs.writeFile(u.home + '/' + f, '');
  for (const d of dirs) fs.mkdir(u.home + '/' + d);
  fs.actor = prev;
}
