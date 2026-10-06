/**
 * The lab: exercise state, rule checking (vet), meta commands, check and hint.
 * All text shown to the student goes through tr(english, dutch).
 */
import { VFS, basename, dirname, isAbs, join, normpath } from './vfs';
import { Spec, Target, generate } from './generator';
import { COMMANDS, Ctx } from './commands';
import { expandGlob, tokenize } from './shell';
import { bold, cyan, dim, green, magenta, red, yellow } from './ansi';
import { tr } from './i18n';

export const ROOT = '/home/student';
export const ALLOWED = ['ls', 'pwd', 'cd', 'cp', 'mv', 'touch', 'mkdir', 'rm', 'rmdir', 'tree'];
export const META = ['task', 'check', 'hint', 'help', 'reset', 'new', 'clear', 'exit', 'quit'];
const SHELL_CHARS = '|;&<>`$';
export const MARKER = '.labid'; // hidden id file inside directories that must be copied/moved

export interface State {
  violations: number;
  commands: number;
  solved: boolean;
  started: string;
  solvedAt?: string;
}

interface Vet { ok: boolean; msg: string | null; violation: boolean }

const pathStyle = (arg: string): 'abs' | 'rel' => (arg.startsWith('/') ? 'abs' : 'rel');

/** Separate option tokens from path tokens (stops at '--'). */
function splitOpts(args: string[]): { opts: string[]; paths: string[] } {
  const opts: string[] = [];
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { paths.push(...args.slice(i + 1)); break; }
    if (a.startsWith('-') && a.length > 1) opts.push(a); else paths.push(a);
  }
  return { opts, paths };
}

function hasFlag(opts: string[], ...names: string[]): boolean {
  for (const o of opts) {
    if (o.startsWith('--')) { if (names.includes(o.slice(2))) return true; }
    else for (const ch of o.slice(1)) if (names.includes(ch)) return true;
  }
  return false;
}

const kindWord = (t: string) => (t === 'dir' ? tr('directory', 'map') : tr('file', 'bestand'));

export class Lab {
  fs = new VFS();
  spec!: Spec;
  state!: State;
  cwd = ROOT + '/work';
  prev = ROOT + '/work';
  width = 80;
  /** Asks a yes/no question (window.confirm in the browser). */
  confirm: (q: string) => boolean = () => true;
  /** Called after every command / new exercise so the owner can persist. */
  onChange: () => void = () => {};
  private buf: string[] = [];

  // ---- output ----------------------------------------------------------------
  print(s = ''): void { this.buf.push(s.replace(/\r?\n/g, '\r\n') + '\r\n'); }

  // ---- exercise lifecycle ----------------------------------------------------
  get targets() { return this.spec.targets; }
  get junk() { return this.spec.junk; }

  restore(spec: Spec, state: State, fsData: unknown): void {
    this.spec = spec;
    this.state = state;
    this.fs = VFS.fromJSON(fsData);
    this.cwd = this.prev = ROOT + '/work';
  }

  startNew(seed: number, level: number): void {
    this.spec = generate(seed, level);
    this.fs = new VFS();
    this.fs.mkdirp(ROOT + '/work');
    this.fs.mkdirp(ROOT + '/stock');
    this.materialize();
    this.state = { violations: 0, commands: 0, solved: false, started: new Date().toISOString() };
    this.cwd = this.prev = ROOT + '/work';
    this.onChange();
  }

  private materialize(): void {
    const make = (rel: string, typ: string, content: string, token?: string | null) => {
      const full = join(ROOT, rel);
      if (typ === 'dir') {
        this.fs.mkdirp(full);
        if (token) this.fs.writeFile(join(full, MARKER), `LAB-ID ${token}\n`);
      } else {
        this.fs.mkdirp(dirname(full));
        this.fs.writeFile(full, content);
      }
    };
    for (const [rel, n] of Object.entries(this.targets)) {
      if (n.mode === 'exists') make(rel, n.type, 'This file was already here.\n');
      else if (n.mode === 'restricted' || n.mode === 'inherit') {
        make(n.source!, n.type, `LAB-ID ${n.token}\nThis file must be copied or moved, not recreated.\n`, n.token);
      }
    }
    for (const [rel, j] of Object.entries(this.junk)) make(rel, j.type, 'junk\n');
  }

  // ---- paths -----------------------------------------------------------------
  expandTilde(tok: string): string {
    if (tok === '~') return ROOT;
    if (tok.startsWith('~/')) return ROOT + tok.slice(1);
    return tok;
  }
  resolve(arg: string): string { return normpath(isAbs(arg) ? arg : join(this.cwd, arg)); }
  inside(full: string): boolean { return full === ROOT || full.startsWith(ROOT + '/'); }
  rel(full: string): string { return full === ROOT ? '' : full.startsWith(ROOT + '/') ? full.slice(ROOT.length + 1) : full; }
  disp(full: string): string { const r = this.rel(full); return r === '' ? '~' : '~/' + r; }
  prompt(): string { return `student@lab:${this.disp(this.cwd)}$ `; }

  // ---- rule checking ---------------------------------------------------------
  vet(cmd: string, args: string[]): Vet {
    const ok: Vet = { ok: true, msg: null, violation: false };
    const block = (msg: string): Vet => ({ ok: false, msg, violation: false });
    const violate = (msg: string): Vet => ({ ok: false, msg, violation: true });
    const { opts, paths } = splitOpts(args);
    const protectedPaths = new Set([ROOT, ROOT + '/work', ROOT + '/stock']);

    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const full = this.resolve(p);
      if (!this.inside(full)) {
        return block(tr(`'${p}' is outside the lab. Everything happens inside ${ROOT}.`,
          `'${p}' ligt buiten het lab. Alles gebeurt binnen ${ROOT}.`));
      }
      const isDest = (cmd === 'cp' || cmd === 'mv') && i === paths.length - 1;
      if ((cmd === 'rm' || cmd === 'rmdir' || cmd === 'mv') && protectedPaths.has(full) && !isDest) {
        return block(tr(`'${p}' is part of the lab layout and cannot be removed or moved.`,
          `'${p}' maakt deel uit van de labstructuur en kan niet verwijderd of verplaatst worden.`));
      }
    }

    if (cmd === 'mkdir') {
      const parents = hasFlag(opts, 'p', 'parents');
      for (const p of paths) {
        const full = this.resolve(p);
        const created = [full];
        if (parents) {
          let a = dirname(full);
          while (this.inside(a) && !this.fs.exists(a)) { created.push(a); a = dirname(a); }
        }
        for (const cr of created) {
          const v = this.checkCreation(cr, pathStyle(p), 'mkdir');
          if (v) return violate(v);
        }
      }
    } else if (cmd === 'touch') {
      for (const p of paths) {
        const full = this.resolve(p);
        if (!this.fs.exists(full)) {
          const v = this.checkCreation(full, pathStyle(p), 'touch');
          if (v) return violate(v);
        }
      }
    } else if (cmd === 'rm') {
      const rec = hasFlag(opts, 'r', 'R', 'recursive');
      for (const p of paths) {
        const full = this.resolve(p);
        const affected = [full, ...(rec && this.fs.isDir(full) ? this.fs.descendants(full) : [])];
        for (const a of affected) {
          const v = this.checkRemoval(a, pathStyle(p), 'rm');
          if (v) return violate(v);
        }
      }
    } else if (cmd === 'rmdir') {
      for (const p of paths) {
        const v = this.checkRemoval(this.resolve(p), pathStyle(p), 'rmdir');
        if (v) return violate(v);
      }
    } else if (cmd === 'cp' || cmd === 'mv') {
      if (paths.length < 2) return ok;
      const dest = paths[paths.length - 1];
      const srcs = paths.slice(0, -1);
      const destFull = this.resolve(dest);
      if (destFull === ROOT) {
        return block(tr(`You cannot ${cmd} things onto the lab root itself.`,
          `Je kunt niets met ${cmd} op de lab-hoofdmap zelf zetten.`));
      }
      if (cmd === 'mv') {
        for (const s of srcs) {
          const sfull = this.resolve(s);
          for (const a of [sfull, ...this.fs.descendants(sfull)]) {
            const v = this.checkRemoval(a, pathStyle(s), 'mv');
            if (v) return violate(v);
          }
        }
      }
      for (const s of srcs) {
        const final = this.fs.isDir(destFull) || srcs.length > 1
          ? join(destFull, basename(normpath(s))) : destFull;
        const node = this.targets[this.rel(final)];
        if (node && node.style && node.style !== pathStyle(dest)) {
          return violate(this.styleMsg(final, node.style, pathStyle(dest)));
        }
        const sfull = this.resolve(s);
        if (this.fs.isDir(sfull)) {
          for (const d of this.fs.descendants(sfull)) {
            const mapped = normpath(join(final, d.slice(sfull.length + 1)));
            const n = this.targets[this.rel(mapped)];
            if (n && n.style && n.style !== pathStyle(dest)) return violate(this.styleMsg(mapped, n.style, pathStyle(dest)));
          }
        }
      }
    }
    return ok;
  }

  private styleMsg(full: string, wanted: string, used: string): string {
    return tr('%s must be handled with %s path (you used %s one).',
      '%s moet behandeld worden met %s pad (jij gebruikte %s pad).')
      .replace('%s', this.disp(full))
      .replace('%s', wanted === 'abs' ? tr('an ABSOLUTE', 'een ABSOLUUT') : tr('a RELATIVE', 'een RELATIEF'))
      .replace('%s', used === 'abs' ? tr('an absolute', 'een absoluut') : tr('a relative', 'een relatief'));
  }

  private checkCreation(full: string, style: string, cmd: string): string | null {
    const node = this.targets[this.rel(full)];
    if (!node) return null;
    if (node.mode === 'restricted' || node.mode === 'inherit') {
      return tr(`${cmd} is not allowed for ${this.disp(full)}: that one has to be copied or moved from ~/${node.source}.`,
        `${cmd} is niet toegestaan voor ${this.disp(full)}: die moet je kopiëren of verplaatsen vanuit ~/${node.source}.`);
    }
    if (node.style && node.style !== style) return this.styleMsg(full, node.style, style);
    return null;
  }

  private checkRemoval(full: string, style: string, cmd: string): string | null {
    const j = this.junk[this.rel(full)];
    if (!j) return null;
    if (j.rmdirOnly && cmd !== 'rmdir') {
      return tr(`${this.disp(full)} is an empty directory that must be removed with rmdir (not ${cmd}).`,
        `${this.disp(full)} is een lege map die je met rmdir moet verwijderen (niet met ${cmd}).`);
    }
    if (j.style && j.style !== style) return this.styleMsg(full, j.style, style);
    return null;
  }

  // ---- command execution -----------------------------------------------------
  /** Run one command line; returns the terminal output (with \r\n line endings). */
  handle(line: string): string {
    this.buf = [];
    try { this.dispatch(line); } finally { this.fixCwd(); this.onChange(); }
    return this.buf.join('');
  }

  private fixCwd(): void {
    while (!this.fs.isDir(this.cwd) && this.cwd !== ROOT) this.cwd = dirname(this.cwd);
    if (!this.fs.isDir(this.prev)) this.prev = this.cwd;
  }

  private dispatch(line: string): void {
    let tokens: string[];
    try { tokens = tokenize(line); } catch (e) {
      this.print(tr('syntax error: ', 'syntaxfout: ') + (e as Error).message);
      return;
    }
    if (!tokens.length) return;
    const cmd = tokens[0];
    const rawArgs = tokens.slice(1);

    if (META.includes(cmd)) { this.meta(cmd); return; }
    if (!ALLOWED.includes(cmd)) {
      this.print(tr(`${cmd}: not available in the lab. You have: ${ALLOWED.join(' ')}`,
        `${cmd}: niet beschikbaar in het lab. Je hebt: ${ALLOWED.join(' ')}`));
      this.print(dim(`(plus: ${META.join(' ')})`));
      return;
    }
    for (const t of tokens) {
      if ([...t].some(ch => SHELL_CHARS.includes(ch))) {
        this.print(tr('Pipes, redirection, chaining and variables are disabled in the lab. Wildcards (*) do work.',
          "Pipes, omleidingen, ketens van commando's en variabelen staan uit in het lab. Wildcards (*) werken wel."));
        return;
      }
    }

    const args: string[] = [];
    for (let a of rawArgs) {
      a = this.expandTilde(a);
      if (a.startsWith('-') && a.length > 1) args.push(a);
      else args.push(...expandGlob(this.fs, this.cwd, a));
    }

    this.state.commands++;
    if (cmd === 'pwd') { this.print(this.cwd); return; }
    if (cmd === 'cd') { this.doCd(args); return; }

    const v = this.vet(cmd, args);
    if (!v.ok) {
      if (v.violation) {
        this.state.violations++;
        this.print(red(tr('✗ rule violation: ', '✗ regelovertreding: ')) + v.msg);
        this.print(dim(tr(`  (command not executed - violations so far: ${this.state.violations})`,
          `  (commando niet uitgevoerd - overtredingen tot nu toe: ${this.state.violations})`)));
      } else {
        this.print(red(tr('✗ blocked: ', '✗ geblokkeerd: ')) + v.msg);
      }
      return;
    }

    const ctx: Ctx = { fs: this.fs, cwd: this.cwd, width: this.width, print: s => this.print(s) };
    COMMANDS[cmd](ctx, args);
  }

  private doCd(args: string[]): void {
    if (args.length > 1) { this.print(tr('cd: too many arguments', 'cd: te veel argumenten')); return; }
    let target = args[0] ?? ROOT;
    if (target === '-') target = this.prev;
    const full = this.resolve(target);
    if (!this.inside(full)) {
      this.print(red(tr('✗ blocked: ', '✗ geblokkeerd: ')) +
        tr(`you cannot leave the lab (${ROOT}).`, `je kunt het lab niet verlaten (${ROOT}).`));
      return;
    }
    if (!this.fs.exists(full)) { this.print(tr(`cd: no such file or directory: ${target}`, `cd: bestand of map bestaat niet: ${target}`)); return; }
    if (!this.fs.isDir(full)) { this.print(tr(`cd: not a directory: ${target}`, `cd: geen map: ${target}`)); return; }
    this.prev = this.cwd;
    this.cwd = full;
  }

  // ---- meta commands ---------------------------------------------------------
  private meta(cmd: string): void {
    if (cmd === 'exit' || cmd === 'quit') {
      this.print(tr('This is the browser lab - just close the tab. Your progress is saved.',
        'Dit is het browser-lab - sluit gewoon het tabblad. Je voortgang wordt bewaard.'));
    } else if (cmd === 'clear') this.buf.push('\x1b[2J\x1b[H');
    else if (cmd === 'help') this.showHelp();
    else if (cmd === 'task') this.showTask();
    else if (cmd === 'check') this.check();
    else if (cmd === 'hint') this.hint();
    else if (cmd === 'reset' || cmd === 'new') {
      const what = cmd === 'reset'
        ? tr('restart this exercise from scratch', 'deze oefening helemaal opnieuw starten')
        : tr('start a NEW random exercise', 'een NIEUWE willekeurige oefening starten');
      const q = tr(`This will ${what} and wipe ~/work and ~/stock. Continue?`,
        `Dit gaat ${what} en ~/work en ~/stock wissen. Doorgaan?`);
      if (!this.confirm(q)) { this.print(tr('cancelled', 'geannuleerd')); return; }
      const level = this.spec.level;
      const seed = cmd === 'reset' ? this.spec.seed : 1 + Math.floor(Math.random() * 99999);
      this.startNew(seed, level);
      this.showTask();
    }
  }

  showHelp(): void {
    this.print(bold(tr('Available commands', "Beschikbare commando's")));
    this.print('  ' + ALLOWED.join('  '));
    this.print(bold(tr('Lab commands', "Lab-commando's")));
    const rows: [string, string][] = [
      ['task', tr('show the exercise again', 'toon de oefening opnieuw')],
      ['check', tr('verify your work', 'controleer je werk')],
      ['hint', tr('one nudge in the right direction', 'een duwtje in de goede richting')],
      ['reset', tr('same exercise, fresh start', 'dezelfde oefening, opnieuw beginnen')],
      ['new', tr('a different random exercise', 'een andere willekeurige oefening')],
      ['exit', tr('leave the lab', 'verlaat het lab')],
    ];
    for (const [n, d] of rows) this.print('  ' + n.padEnd(7) + ' ' + d);
    this.print(bold(tr('Notes', 'Opmerkingen')));
    this.print(tr(`  ~ stands for the lab directory (${ROOT}); ~/... counts as an absolute path.`,
      `  ~ staat voor de labmap (${ROOT}); ~/... telt als een absoluut pad.`));
    this.print(tr('  Wildcards like *.txt work. Pipes, redirection and ; && are off.',
      '  Wildcards zoals *.txt werken. Pipes, omleidingen en ; && staan uit.'));
  }

  private annotation(n: Target): string {
    if (n.mode === 'restricted') {
      return yellow(tr(`★ no mkdir/touch → copy or move it from ~/${n.source}`,
        `★ geen mkdir/touch → kopieer of verplaats het vanuit ~/${n.source}`));
    }
    if (n.mode === 'inherit') {
      return dim(tr(`(comes along automatically with the directory above it: ~/${n.source})`,
        `(gaat automatisch mee met de map erboven: ~/${n.source})`));
    }
    if (n.mode === 'exists') return dim(tr('(already there)', '(staat er al)'));
    if (n.style === 'abs') return cyan(tr('◆ create it with an ABSOLUTE path', '◆ maak het aan met een ABSOLUUT pad'));
    if (n.style === 'rel') return magenta(tr('◆ create it with a RELATIVE path', '◆ maak het aan met een RELATIEF pad'));
    return '';
  }

  showTask(): void {
    const s = this.spec;
    this.print();
    this.print(bold(tr(`═══ Exercise #${s.seed} (level ${s.level}) ═══`, `═══ Oefening #${s.seed} (niveau ${s.level}) ═══`)));
    this.print(tr(`Lab directory: ${ROOT}   (shown as ~ in the prompt)`, `Labmap: ${ROOT}   (in de prompt weergegeven als ~)`));
    this.print(tr('Make ~/work look EXACTLY like this - nothing more, nothing less:',
      'Zorg dat ~/work er EXACT zo uitziet - niets meer, niets minder:'));
    this.print();
    const rows: [string, string][] = [['work/', '']];
    const children = new Map<string, string[]>();
    for (const rel of Object.keys(this.targets)) {
      const p = dirname(rel);
      children.set(p, [...(children.get(p) ?? []), rel]);
    }
    const walk = (parent: string, prefix: string) => {
      const kids = (children.get(parent) ?? []).sort((a, b) => {
        const x = basename(a).toLowerCase(), y = basename(b).toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
      });
      kids.forEach((k, i) => {
        const last = i === kids.length - 1;
        const n = this.targets[k];
        rows.push([prefix + (last ? '└── ' : '├── ') + basename(k) + (n.type === 'dir' ? '/' : ''), this.annotation(n)]);
        if (n.type === 'dir') walk(k, prefix + (last ? '    ' : '│   '));
      });
    };
    walk('work', '');
    const width = Math.max(...rows.map(r => r[0].length)) + 2;
    for (const [left, ann] of rows) this.print('  ' + left.padEnd(width) + ann);

    this.print();
    this.print(bold(tr('Remove from ~/work', 'Verwijder uit ~/work')) +
      tr(' (everything that is not in the picture above must go):', ' (alles wat niet in bovenstaande afbeelding staat moet weg):'));
    for (const [rel, j] of Object.entries(this.junk)) {
      if (j.child) continue;
      const what = j.type === 'file' ? tr('file', 'bestand')
        : j.nonempty ? tr('directory with stuff inside', 'map met inhoud') : tr('empty directory', 'lege map');
      let extra = '';
      if (j.rmdirOnly) extra += '  ' + red(tr('rmdir only - no rm!', 'enkel rmdir - geen rm!'));
      if (j.style === 'abs') extra += '  ' + cyan(tr('◆ remove it with an ABSOLUTE path', '◆ verwijder het met een ABSOLUUT pad'));
      if (j.style === 'rel') extra += '  ' + magenta(tr('◆ remove it with a RELATIVE path', '◆ verwijder het met een RELATIEF pad'));
      this.print('  ' + ('~/' + rel + (j.type === 'dir' ? '/' : '')).padEnd(30) + ' ' + what + extra);
    }
    if (Object.values(this.targets).some(n => n.mode === 'restricted' && n.source!.startsWith('work/'))) {
      this.print('  ' + dim(tr('(items marked ★ that currently live inside ~/work must end up at their new place only)',
        '(items met ★ die nu in ~/work staan, mogen enkel op hun nieuwe plaats terechtkomen)')));
    }
    this.print();
    this.print(bold(tr('Rules', 'Regels')));
    this.print(tr(`  • Commands: ${ALLOWED.join(' ')}   (type \`help\` for the lab commands)`,
      `  • Commando's: ${ALLOWED.join(' ')}   (typ \`help\` voor de lab-commando's)`));
    this.print('  • ' + yellow('★') + tr(' items may NOT be made with mkdir/touch - bring them over with cp or mv.',
      ' items mag je NIET met mkdir/touch maken - breng ze over met cp of mv.'));
    this.print('  • ' + cyan('◆') + tr(' items must be created/removed with the stated kind of path (~/... is absolute).',
      ' items moet je aanmaken/verwijderen met het opgegeven soort pad (~/... is absoluut).'));
    this.print('  • ' + tr('Directories marked ', 'Mappen met ') + red(tr('rmdir only', 'enkel rmdir')) +
      tr(' may not be removed with rm.', ' mag je niet met rm verwijderen.'));
    this.print(tr('  • ~/stock may be left in any state. Breaking a rule blocks the command and is counted.',
      '  • ~/stock mag in elke toestand blijven. Een regel breken blokkeert het commando en wordt geteld.'));
    this.print('  • ' + tr('Type ', 'Typ ') + bold('check') + tr(' when you think you are done.', ' wanneer je denkt dat je klaar bent.'));
    this.print();
  }

  // ---- verification ----------------------------------------------------------
  /** What is currently inside ~/work, as rel path -> kind (marker files left out). */
  private actual(): Map<string, string> {
    const m = new Map<string, string>();
    for (const full of this.fs.descendants(ROOT + '/work')) {
      if (basename(full) === MARKER) continue;
      m.set(this.rel(full), this.fs.isDir(full) ? 'dir' : 'file');
    }
    return m;
  }

  /** True when ~/work matches the target exactly (no output). */
  isSolved(): boolean { return this.analyse().ok; }

  private analyse() {
    const actual = this.actual();
    const missing: string[] = [], wrongType: string[] = [], badContent: string[] = [];
    for (const [rel, n] of Object.entries(this.targets)) {
      const a = actual.get(rel);
      if (a === undefined) missing.push(rel);
      else if (a !== n.type) wrongType.push(rel);
      else if (n.token) {
        let path = join(ROOT, rel);
        if (n.type === 'dir') path = join(path, MARKER);
        const node = this.fs.get(path);
        if (!node || node.type !== 'file' || !node.content.includes(n.token)) badContent.push(rel);
      }
    }
    const extra: string[] = [];
    for (const rel of [...actual.keys()].sort()) {
      if (rel in this.targets) continue;
      if (extra.some(e => rel.startsWith(e + '/'))) continue;
      extra.push(rel);
    }
    return { actual, missing, wrongType, badContent, extra, ok: !(missing.length || wrongType.length || badContent.length || extra.length) };
  }

  check(): boolean {
    const { actual, missing, wrongType, badContent, extra, ok } = this.analyse();
    const total = Object.keys(this.targets).length;
    const present = total - missing.length - wrongType.length;
    const slash = (rel: string) => (this.targets[rel]?.type === 'dir' ? '/' : '');
    this.print();
    this.print(bold('── check ──────────────────────────────────────'));
    this.print((present === total ? green('✔') : yellow('•')) +
      tr(` ${present}/${total} target items present`, ` ${present}/${total} doelitems aanwezig`));
    if (missing.length) {
      this.print(red(tr(`✘ missing (${missing.length}):`, `✘ ontbreekt (${missing.length}):`)));
      for (const r of missing) this.print(`    ~/${r}${slash(r)}`);
    }
    if (wrongType.length) {
      this.print(red(tr(`✘ wrong kind (${wrongType.length}):`, `✘ verkeerd soort (${wrongType.length}):`)));
      for (const r of wrongType) {
        this.print(tr(`    ~/${r} should be a ${this.targets[r].type}`, `    ~/${r} moet een ${kindWord(this.targets[r].type)} zijn`));
      }
    }
    if (badContent.length) {
      this.print(red(tr(`✘ not the original (${badContent.length}):`, `✘ niet het origineel (${badContent.length}):`)));
      for (const r of badContent) {
        const t = this.targets[r];
        this.print(tr(`    ~/${r} is not the original ${t.type} from ~/${t.source} (recreated instead of copied/moved?)`,
          `    ~/${r} is niet het originele ${kindWord(t.type)} uit ~/${t.source} (opnieuw aangemaakt in plaats van gekopieerd/verplaatst?)`));
      }
    }
    if (extra.length) {
      this.print(red(tr(`✘ should not be there (${extra.length}):`, `✘ hoort er niet te staan (${extra.length}):`)));
      for (const r of extra) this.print(`    ~/${r}${actual.get(r) === 'dir' ? '/' : ''}`);
    }
    const v = this.state.violations;
    this.print(tr('rule violations: ', 'regelovertredingen: ') + (v === 0 ? green('0') : red(String(v))) +
      tr('   commands run: ', "   uitgevoerde commando's: ") + this.state.commands);
    if (ok) {
      this.print(green(bold(tr('RESULT: SOLVED ✔', 'RESULTAAT: OPGELOST ✔'))) +
        (v === 0 ? '' : yellow(tr(`  (but with ${v} rule violation(s))`, `  (maar met ${v} regelovertreding(en))`))));
    } else {
      this.print(yellow(tr('RESULT: not yet - keep going (type `hint` if you are stuck)',
        'RESULTAAT: nog niet - ga door (typ `hint` als je vastzit)')));
    }
    this.print();
    if (ok && !this.state.solved) {
      this.state.solved = true;
      this.state.solvedAt = new Date().toISOString();
    }
    return ok;
  }

  hint(): void {
    const actual = this.actual();
    for (const [rel, n] of Object.entries(this.targets)) {
      if (actual.has(rel)) continue;
      const kind = kindWord(n.type);
      if (n.mode === 'restricted' || n.mode === 'inherit') {
        this.print(tr(`Missing: ~/${rel} (${kind}). It exists as ~/${n.source} - use cp or mv to bring it over.`,
          `Ontbreekt: ~/${rel} (${kind}). Het bestaat als ~/${n.source} - gebruik cp of mv om het over te brengen.`));
      } else {
        const how = n.type === 'dir' ? 'mkdir' : 'touch';
        const style = n.style === 'abs' ? tr(' using an absolute path (starts with / or ~/)', ' met een absoluut pad (begint met / of ~/)')
          : n.style === 'rel' ? tr(' using a relative path (seen from your current directory - `pwd`)',
            ' met een relatief pad (gezien vanuit je huidige map - `pwd`)') : '';
        this.print(tr(`Missing: ~/${rel} (${kind}). Create it with ${how}${style}.`,
          `Ontbreekt: ~/${rel} (${kind}). Maak het aan met ${how}${style}.`));
      }
      return;
    }
    for (const rel of [...actual.keys()].sort()) {
      if (rel in this.targets) continue;
      const j = this.junk[rel];
      const full = join(ROOT, rel);
      if (j?.rmdirOnly) {
        this.print(tr(`~/${rel} should not be there. It is empty, so rmdir is the tool.`,
          `~/${rel} hoort er niet te staan. Het is leeg, dus rmdir is het juiste gereedschap.`));
      } else if (this.fs.isDir(full) && this.fs.list(full).length) {
        this.print(tr(`~/${rel} should not be there. It has contents, so rm needs its recursive option.`,
          `~/${rel} hoort er niet te staan. Er zit inhoud in, dus rm heeft de recursieve optie nodig.`));
      } else if (this.fs.isDir(full)) {
        this.print(tr(`~/${rel} should not be there (empty directory).`, `~/${rel} hoort er niet te staan (lege map).`));
      } else {
        this.print(tr(`~/${rel} should not be there (file) - rm it.`, `~/${rel} hoort er niet te staan (bestand) - verwijder het met rm.`));
      }
      return;
    }
    this.print(tr('The structure looks complete. Run `check` to verify the details.',
      'De structuur lijkt compleet. Voer `check` uit om de details te controleren.'));
  }

  // ---- tab completion --------------------------------------------------------
  complete(line: string): string[] {
    const idx = line.lastIndexOf(' ');
    const head = idx >= 0 ? line.slice(0, idx) : '';
    const text = line.slice(idx + 1);
    if (head.trim() === '') return [...ALLOWED, ...META].filter(w => w.startsWith(text)).map(w => w + ' ');
    return this.pathCandidates(text);
  }

  private pathCandidates(text: string): string[] {
    const t = this.expandTilde(text);
    const i = t.lastIndexOf('/');
    const d = i < 0 ? '' : t.slice(0, i) || '/';
    const base = i < 0 ? t : t.slice(i + 1);
    const search = d ? this.resolve(d) : this.cwd;
    if (!this.inside(search) || !this.fs.isDir(search)) return [];
    const prefix = text.slice(0, text.length - base.length);
    const out: string[] = [];
    for (const n of this.fs.list(search).sort()) {
      if (!n.startsWith(base) || (base === '' && n.startsWith('.'))) continue;
      out.push(prefix + n + (this.fs.isDir(join(search, n)) ? '/' : ' '));
    }
    return out;
  }
}
