// The short code a person compares with what their agent shows before approving it: the device flow's user code
// (src/agent-setup.ts) and a support inbox agent's request (src/support-agents.ts).
// RFC 8628 §6.1: twenty consonants, no vowels (no words) and none easily confused.
export const USER_CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';

export function newUserCode() {
  let code = '';
  while (code.length < 8) for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 240 && code.length < 8) code += USER_CODE_LETTERS[byte % 20];
  return code;
}
/** The user code as people see and type it: BCDF-GHJK. */
export const shownCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
/** A typed user code, any case, with or without its hyphen or spaces; null if it can't be one. */
export function typedCode(value: string) {
  const code = value.toUpperCase().replace(/[\s-]/g, '');
  return new RegExp(`^[${USER_CODE_LETTERS}]{8}$`).test(code) ? code : null;
}
