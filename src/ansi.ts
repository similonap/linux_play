const c = (text: string, code: string) => `\x1b[${code}m${text}\x1b[0m`;

export const bold = (t: string) => c(t, '1');
export const red = (t: string) => c(t, '31');
export const green = (t: string) => c(t, '32');
export const yellow = (t: string) => c(t, '33');
export const blue = (t: string) => c(t, '34');
export const magenta = (t: string) => c(t, '35');
export const cyan = (t: string) => c(t, '36');
export const dim = (t: string) => c(t, '2');
