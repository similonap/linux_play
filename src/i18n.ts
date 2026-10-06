export type Lang = 'nl' | 'en';

let current: Lang = 'nl';

export function getLang(): Lang { return current; }
export function setLang(l: Lang): void { current = l; }

/** Pick the English or Dutch text for the current interface language. */
export function tr(en: string, nl: string): string {
  return current === 'nl' ? nl : en;
}
