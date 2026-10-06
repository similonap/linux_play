import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { Session, Store } from './session';
import { Lang, getLang, setLang } from './i18n';

const I18N: Record<Lang, Record<string, string>> = {
  nl: {
    btnTask: 'Opdracht', btnHint: 'Hint', btnTree: 'Tree', btnCheck: 'Controleer', btnNew: 'Nieuw',
    btnNewTitle: 'een andere willekeurige oefening',
    footCmds: "Commando's: ls pwd cd cp mv touch mkdir rm rmdir tree",
    footLab: 'Lab: task · check · hint · help · reset · new',
    footSaved: 'voortgang wordt in deze browser bewaard',
    exercise: 'oefening', level: 'niveau', commands: "commando's", violations: 'overtredingen',
    solved: 'opgelost ✔', unsolved: 'niet opgelost',
  },
  en: {
    btnTask: 'Task', btnHint: 'Hint', btnTree: 'Tree', btnCheck: 'Check', btnNew: 'New',
    btnNewTitle: 'a different random exercise',
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
const session = new Session({
  store, confirm: q => window.confirm(q), seed: num('seed'), level: num('level'), lang,
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
  $('ex').innerHTML = `${t('exercise')} <b>#${s.seed}</b> · ${t('level')} ${s.level}`;
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
  term.clear();
  term.write('\x1b[2J\x1b[H' + session.banner());   // show the instructions in the new language
  newPrompt();
  term.focus();
}));

// ---- go --------------------------------------------------------------------------------
applyLang();
term.write(session.banner());
newPrompt();
term.focus();
