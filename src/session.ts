import { Lab, State, WorldState } from './lab';
import { Spec, Options, presetOptions, sameOptions, isCustom } from './generator';
import { Lang, setLang, tr } from './i18n';
import { bold, dim } from './ansi';

export interface Store { load(): string | null; save(data: string): void }

export interface SessionOpts {
  store: Store;
  confirm: (q: string) => boolean;
  seed?: number;
  /** Settings for new exercises. */
  options?: Options;
  /** The settings came from the URL: a saved exercise with other settings is replaced. */
  explicit?: boolean;
  lang?: Lang;
}

export interface Info {
  seed: number; difficulty: number; custom: boolean; commands: number; violations: number; solved: boolean;
  missionsDone: number; missionsTotal: number;
}

const SAVE_VERSION = 3;

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
        const d = JSON.parse(raw) as { v: number; spec: Spec; state: State; fs: unknown; world: WorldState };
        if (d.v === SAVE_VERSION) { this.lab.restore(d.spec, d.state, d.fs, d.world); loaded = true; }
      }
    } catch { loaded = false; }

    this.lab.options = o.options ?? presetOptions(2);
    const stale = loaded && ((o.seed !== undefined && this.lab.spec.seed !== o.seed)
      || (o.explicit === true && !sameOptions(this.lab.spec.options!, this.lab.options)));
    if (!loaded || stale) {
      this.lab.startNew(o.seed ?? 1 + Math.floor(Math.random() * 99999), this.lab.options);
      loaded = false;
    }
    this.resumed = loaded;
    this.lab.onChange = () => this.save();
    this.save();
  }

  private save(): void {
    try {
      this.store.save(JSON.stringify({ v: SAVE_VERSION, spec: this.lab.spec, state: this.lab.state, fs: this.lab.fs.toJSON(), world: this.lab.worldState() }));
    } catch { /* storage full or unavailable: the lab still works, it just will not survive a reload */ }
  }

  setLang(l: Lang): void { setLang(l); }

  /** Settings for the next `new` / start a new exercise with them right now. */
  setOptions(options: Options): void { this.lab.options = options; }
  startNew(options: Options): string {
    this.lab.options = options;
    this.lab.startNew(1 + Math.floor(Math.random() * 99999), options);
    this.resumed = false;
    return this.banner();
  }
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
  /** true while the lab waits for a password: the terminal must not echo what is typed */
  isSecret(): boolean { return !!this.lab.pending?.secret; }
  isAsking(): boolean { return !!this.lab.pending; }
  interrupt(): void { this.lab.interrupt(); }
  complete(line: string): string[] { return this.lab.complete(line); }

  info(): Info {
    const { spec, state } = this.lab;
    return { seed: spec.seed, difficulty: spec.level, custom: !!spec.options && isCustom(spec.options),
      commands: state.commands, violations: state.violations, solved: state.solved,
      missionsDone: (spec.missions ?? []).filter(m => state.done.includes(m.id)).length, missionsTotal: (spec.missions ?? []).length };
  }
}

