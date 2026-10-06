import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { Session, Store } from './session';
import { Lang, getLang, setLang, difficultyName } from './i18n';
import { Options, Features, FEATURE_KEYS, FeatureKey, Difficulty, presetOptions, normalizeFeatures, isCustom } from './generator';

const I18N: Record<Lang, Record<string, string>> = {
  nl: {
    btnTask: 'Opdracht', btnHint: 'Hint', btnTree: 'Tree', btnCheck: 'Controleer', btnNew: 'Nieuw',
    btnNewTitle: 'een andere willekeurige oefening (met je instellingen)',
    btnSettings: '⚙ Instellingen',
    setTitle: 'Instellingen', setDifficulty: 'Moeilijkheid', setFeatures: 'Wat wil je oefenen?',
    setDiffHint: 'De moeilijkheid bepaalt de grootte van de oefening en welke onderdelen standaard aan staan.',
    setFeaturesHint: 'Aanmaken (mkdir, touch) en navigeren (cd, ls, tree) zit er altijd in.',
    setCancel: 'Annuleer', setStart: 'Start nieuwe oefening', custom: 'aangepast',
    setConfirm: 'Je huidige oefening wordt vervangen. Doorgaan?',
    footCmds: "Commando's: ls pwd cd cp mv touch mkdir rm rmdir tree",
    footLab: 'Lab: task · check · hint · help · reset · new',
    footSaved: 'voortgang wordt in deze browser bewaard',
    exercise: 'oefening', level: 'niveau', commands: "commando's", violations: 'overtredingen',
    solved: 'opgelost ✔', unsolved: 'niet opgelost',
  },
  en: {
    btnTask: 'Task', btnHint: 'Hint', btnTree: 'Tree', btnCheck: 'Check', btnNew: 'New',
    btnNewTitle: 'a different random exercise (with your settings)',
    btnSettings: '⚙ Settings',
    setTitle: 'Settings', setDifficulty: 'Difficulty', setFeatures: 'What do you want to practise?',
    setDiffHint: 'Difficulty sets the size of the exercise and which topics are on by default.',
    setFeaturesHint: 'Creating (mkdir, touch) and navigating (cd, ls, tree) are always included.',
    setCancel: 'Cancel', setStart: 'Start new exercise', custom: 'customised',
    setConfirm: 'Your current exercise will be replaced. Continue?',
    footCmds: 'Commands: ls pwd cd cp mv touch mkdir rm rmdir tree',
    footLab: 'Lab: task · check · hint · help · reset · new',
    footSaved: 'progress is saved in this browser',
    exercise: 'exercise', level: 'level', commands: 'commands', violations: 'violations',
    solved: 'solved ✔', unsolved: 'not solved',
  },
};

const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);
const t = (k: string) => I18N[getLang()][k];

// ---- storage + language ---------------------------------------------------------
const SAVE_KEY = 'fslab.save';
const store: Store = {
  load: () => { try { return localStorage.getItem(SAVE_KEY); } catch { return null; } },
  save: d => { try { localStorage.setItem(SAVE_KEY, d); } catch { /* ignore */ } },
};

let lang: Lang = 'nl';
try {
  const q = params.get('lang');
  const saved = localStorage.getItem('fslab.lang');
  lang = q === 'nl' || q === 'en' ? q : saved === 'nl' || saved === 'en' ? saved : 'nl';
} catch { /* default nl */ }
setLang(lang);

// ---- terminal --------------------------------------------------------------------
const term = new Terminal({
  cursorBlink: true, fontSize: 14, scrollback: 5000,
  fontFamily: 'Menlo, "DejaVu Sans Mono", Consolas, monospace',
  theme: { background: '#0f1115', foreground: '#d7dae0', cursor: '#5aa9ff', selectionBackground: '#2b4a73' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('term'));
fit.fit();

const num = (k: string) => (/^\d+$/.test(params.get(k) ?? '') ? Number(params.get(k)) : undefined);

// ---- exercise settings: URL (?level=1-3&features=a,b) > saved in this browser > medium --------
const OPT_KEY = 'fslab.options';
function readOptions(): { options: Options; explicit: boolean } {
  const d = num('level') ?? num('difficulty');
  const list = params.get('features');
  if (d !== undefined || list !== null) {
    const difficulty = ([1, 2, 3].includes(d ?? 0) ? d : 2) as Difficulty;
    if (list === null) return { options: presetOptions(difficulty), explicit: true };
    const on = new Set(list.toLowerCase().split(',').map(x => x.trim()));
    const features = Object.fromEntries(FEATURE_KEYS.map(k => [k, on.has(k.toLowerCase())])) as unknown as Features;
    return { options: { difficulty, features: normalizeFeatures(features) }, explicit: true };
  }
  try {
    const o = JSON.parse(localStorage.getItem(OPT_KEY) ?? 'null') as Options | null;
    if (o && [1, 2, 3].includes(o.difficulty)) return { options: { difficulty: o.difficulty, features: normalizeFeatures(o.features) }, explicit: false };
  } catch { /* use default */ }
  return { options: presetOptions(2), explicit: false };
}
const initial = readOptions();
let settings: Options = initial.options;

const session = new Session({
  store, confirm: q => window.confirm(q), seed: num('seed'), options: settings, explicit: initial.explicit, lang,
});
session.setWidth(term.cols);

let buf = '', cur = 0, prompt = '', hIdx = 0, draft = '';
let history: string[] = [];
let busy = false;
try { history = JSON.parse(localStorage.getItem('fslab.history') ?? '[]'); } catch { /* none */ }
hIdx = history.length;

// ---- header chips / language ---------------------------------------------------------
function renderInfo(): void {
  const s = session.info();
  $('ex').innerHTML = `${t('exercise')} <b>#${s.seed}</b> · ${difficultyName(s.difficulty)}${s.custom ? ' (' + t('custom') + ')' : ''}`;
  $('cmds').innerHTML = `${t('commands')} <b>${s.commands}</b>`;
  $('viol').innerHTML = `${t('violations')} <b>${s.violations}</b>`;
  $('viol').className = 'chip' + (s.violations ? ' bad' : '');
  $('status').textContent = s.solved ? t('solved') : t('unsolved');
  $('status').className = 'chip' + (s.solved ? ' ok' : '');
}

function applyLang(): void {
  document.documentElement.lang = getLang();
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n!); });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle!); });
  document.querySelectorAll<HTMLElement>('.lang button').forEach(b => b.classList.toggle('on', b.dataset.lang === getLang()));
  renderInfo();
}

// ---- prompt + line editor ----------------------------------------------------------
function paintPrompt(): string {
  const m = prompt.match(/^(.*?)(:)(.*)(\$ )$/);
  return m ? `\x1b[1;32m${m[1]}\x1b[0m:\x1b[1;34m${m[3]}\x1b[0m$ ` : prompt;
}
function redraw(): void {
  term.write('\r\x1b[2K' + paintPrompt() + buf + '\r');
  const col = prompt.length + cur;
  if (col > 0) term.write(`\x1b[${col}C`);
}
function newPrompt(): void { prompt = session.prompt(); buf = ''; cur = 0; redraw(); }

function saveHistory(): void {
  try { localStorage.setItem('fslab.history', JSON.stringify(history.slice(-200))); } catch { /* ignore */ }
}

function submit(line: string): void {
  term.write('\r\n');
  const l = line.trim();
  if (l) {
    if (history[history.length - 1] !== l) history.push(l);
    saveHistory();
    const out = session.run(l);
    if (l === 'clear') term.clear();
    term.write(out);
    renderInfo();
  }
  hIdx = history.length; draft = '';
  newPrompt();
}

function complete(): void {
  const line = buf.slice(0, cur);
  const c = session.complete(line);
  if (!c.length) return;
  const text = line.slice(line.lastIndexOf(' ') + 1);
  let common = c[0];
  for (const x of c) while (!x.startsWith(common)) common = common.slice(0, -1);
  if (common.length > text.length) {
    const add = common.slice(text.length);
    buf = buf.slice(0, cur) + add + buf.slice(cur); cur += add.length;
  } else if (c.length > 1) {
    term.write('\r\n' + c.map(x => x.trim()).join('  ') + '\r\n');
  }
  redraw();
}

const SEQS: Record<string, string> = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[3~': 'del', '\x1bOH': 'home', '\x1bOF': 'end',
};

function onKey(d: string): void {
  if (busy) return;
  const items: string[] = [];
  for (let i = 0; i < d.length;) {
    if (d[i] === '\x1b') {
      const k = Object.keys(SEQS).find(s => d.startsWith(s, i));
      if (k) { items.push(SEQS[k]); i += k.length; } else i++;
    } else items.push(d[i++]);
  }
  for (const k of items) {
    if (k === '\r' || k === '\n') submit(buf);
    else if (k === '\x7f' || k === '\b') { if (cur > 0) { buf = buf.slice(0, cur - 1) + buf.slice(cur); cur--; redraw(); } }
    else if (k === 'del') { buf = buf.slice(0, cur) + buf.slice(cur + 1); redraw(); }
    else if (k === 'left') { if (cur > 0) { cur--; redraw(); } }
    else if (k === 'right') { if (cur < buf.length) { cur++; redraw(); } }
    else if (k === 'home' || k === '\x01') { cur = 0; redraw(); }
    else if (k === 'end' || k === '\x05') { cur = buf.length; redraw(); }
    else if (k === 'up') {
      if (hIdx > 0) { if (hIdx === history.length) draft = buf; hIdx--; buf = history[hIdx]; cur = buf.length; redraw(); }
    } else if (k === 'down') {
      if (hIdx < history.length) { hIdx++; buf = hIdx === history.length ? draft : history[hIdx]; cur = buf.length; redraw(); }
    } else if (k === '\x15') { buf = buf.slice(cur); cur = 0; redraw(); }
    else if (k === '\x0b') { buf = buf.slice(0, cur); redraw(); }
    else if (k === '\x03') { term.write('^C\r\n'); newPrompt(); }
    else if (k === '\x0c') { term.clear(); newPrompt(); }
    else if (k === '\t') complete();
    else if (k >= ' ' && k !== '\x7f') { buf = buf.slice(0, cur) + k + buf.slice(cur); cur++; redraw(); }
  }
}
term.onData(onKey);

function relayout(): void { fit.fit(); session.setWidth(term.cols); }
window.addEventListener('resize', relayout);
new ResizeObserver(relayout).observe($('term'));

document.querySelectorAll<HTMLElement>('button.act').forEach(b => b.addEventListener('click', () => {
  buf = b.dataset.cmd!; cur = buf.length; redraw();
  submit(buf);
  term.focus();
}));

document.querySelectorAll<HTMLElement>('.lang button').forEach(b => b.addEventListener('click', () => {
  const l = b.dataset.lang as Lang;
  if (l === getLang()) return;
  session.setLang(l);
  try { localStorage.setItem('fslab.lang', l); } catch { /* ignore */ }
  applyLang();
  if (dlg.open) renderSettings();
  term.clear();
  term.write('\x1b[2J\x1b[H' + session.banner());   // show the instructions in the new language
  newPrompt();
  term.focus();
}));

// ---- settings dialog ----------------------------------------------------------------
const FEATURES: Record<FeatureKey, { nl: [string, string]; en: [string, string] }> = {
  copyMove: { nl: ['Kopiëren en verplaatsen', 'cp en mv i.p.v. mkdir/touch (★)'], en: ['Copying and moving', 'cp and mv instead of mkdir/touch (★)'] },
  abs: { nl: ['Absolute paden', 'beginnen met /'], en: ['Absolute paths', 'start with /'] },
  rel: { nl: ['Relatieve paden', 'vanaf de huidige map, ook met ..'], en: ['Relative paths', 'from the current directory, also with ..'] },
  home: { nl: ['~ (homemap)', 'paden die met ~ beginnen'], en: ['~ (home directory)', 'paths that start with ~'] },
  dot: { nl: ['. als bestemming', 'cd naar de doelmap en dan cp/mv naar . (vraagt kopiëren/verplaatsen)'], en: ['. as destination', 'cd to the target directory, then cp/mv to . (needs copying/moving)'] },
  star: { nl: ['Wildcard *', 'alle bestanden die beginnen of eindigen met …'], en: ['Wildcard *', 'all files that start or end with …'] },
  question: { nl: ['Wildcard ?', 'precies één willekeurig teken'], en: ['Wildcard ?', 'exactly one arbitrary character'] },
  remove: { nl: ['Verwijderen', 'rm en rm -r'], en: ['Deleting', 'rm and rm -r'] },
  rmdirOnly: { nl: ['Lege mappen enkel met rmdir', 'rm mag dan niet (vraagt verwijderen)'], en: ['Empty directories only with rmdir', 'rm is not allowed then (needs deleting)'] },
};
let draft2: Options = settings;
const dlg = $('settings') as HTMLDialogElement;

function renderSettings(): void {
  const seg = $('set-diff');
  seg.innerHTML = '';
  for (const d of [1, 2, 3] as Difficulty[]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = difficultyName(d) + (d === draft2.difficulty && isCustom(draft2) ? ' *' : '');
    b.className = d === draft2.difficulty ? 'on' : '';
    b.onclick = () => { draft2 = presetOptions(d); renderSettings(); };
    seg.appendChild(b);
  }
  const box = $('set-features');
  box.innerHTML = '';
  for (const k of FEATURE_KEYS) {
    const [title, sub] = FEATURES[k][getLang()];
    const off = (k === 'dot' && !draft2.features.copyMove) || (k === 'rmdirOnly' && !draft2.features.remove);
    const label = document.createElement('label');
    label.className = 'feat' + (off ? ' off' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = draft2.features[k] && !off;
    cb.disabled = off;
    cb.onchange = () => {
      draft2 = { ...draft2, features: normalizeFeatures({ ...draft2.features, [k]: cb.checked }) };
      renderSettings();
    };
    const text = document.createElement('span');
    text.innerHTML = `${title}<small>${sub}</small>`;
    label.append(cb, text);
    box.appendChild(label);
  }
}

$('btn-settings').addEventListener('click', () => { draft2 = settings; renderSettings(); dlg.showModal(); });
$('set-cancel').addEventListener('click', () => dlg.close());
$('set-start').addEventListener('click', () => {
  if (session.info().commands > 0 && !window.confirm(t('setConfirm'))) return;
  settings = draft2;
  try { localStorage.setItem(OPT_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  dlg.close();
  term.clear();
  term.write('\x1b[2J\x1b[H' + session.startNew(settings));
  renderInfo();
  newPrompt();
  term.focus();
});

// ---- go --------------------------------------------------------------------------------
applyLang();
term.write(session.banner());
newPrompt();
term.focus();
