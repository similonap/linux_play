import { Lab, State } from './lab';
import { Spec } from './generator';
import { Lang, setLang, tr } from './i18n';
import { bold, dim } from './ansi';

export interface Store { load(): string | null; save(data: string): void }

export interface SessionOpts {
  store: Store;
  confirm: (q: string) => boolean;
  seed?: number;
  level?: number;
  lang?: Lang;
}

export interface Info { seed: number; level: number; commands: number; violations: number; solved: boolean }

const SAVE_VERSION = 2;

/** One student's lab, persisted through `store`. */
export class Session {
  lab = new Lab();
  resumed = false;
  private store: Store;

  constructor(o: SessionOpts) {
    setLang(o.lang ?? 'nl');
    this.store = o.store;
    this.lab.confirm = o.confirm;

    let loaded = false;
    try {
      const raw = this.store.load();
      if (raw) {
        const d = JSON.parse(raw) as { v: number; spec: Spec; state: State; fs: unknown };
        if (d.v === SAVE_VERSION) { this.lab.restore(d.spec, d.state, d.fs); loaded = true; }
      }
    } catch { loaded = false; }

    const stale = loaded && o.seed !== undefined && this.lab.spec.seed !== o.seed;
    if (!loaded || stale) {
      const level = o.level && [1, 2, 3].includes(o.level) ? o.level : 2;
      this.lab.startNew(o.seed ?? 1 + Math.floor(Math.random() * 99999), level);
      loaded = false;
    }
    this.resumed = loaded;
    this.lab.onChange = () => this.save();
    this.save();
  }

  private save(): void {
    try {
      this.store.save(JSON.stringify({ v: SAVE_VERSION, spec: this.lab.spec, state: this.lab.state, fs: this.lab.fs.toJSON() }));
    } catch { /* storage full or unavailable: the lab still works, it just will not survive a reload */ }
  }

  setLang(l: Lang): void { setLang(l); }
  setWidth(cols: number): void { this.lab.width = cols; }

  banner(): string {
    let head = bold('Linux Lab') + tr(' - type `task` to see the exercise, `help` for the commands, `check` to verify.',
      " - typ `task` om de oefening te zien, `help` voor de commando's, `check` om te controleren.");
    if (this.resumed) {
      head += '\r\n' + dim(tr('Resuming your saved exercise (use `new` for a fresh one).',
        'Je opgeslagen oefening wordt hervat (gebruik `new` voor een nieuwe).'));
    }
    // showTask prints through the lab buffer, so run it via handle()
    return head + '\r\n' + this.run('task');
  }

  run(line: string): string { return this.lab.handle(line); }
  prompt(): string { return this.lab.prompt(); }
  complete(line: string): string[] { return this.lab.complete(line); }

  info(): Info {
    const { spec, state } = this.lab;
    return { seed: spec.seed, level: spec.level, commands: state.commands, violations: state.violations, solved: state.solved };
  }
}

