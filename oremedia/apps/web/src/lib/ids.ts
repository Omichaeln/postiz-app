/**
 * Element ids are stable prefixed ULIDs (spec 11.2: `el_` + 26 Crockford base32 characters). New elements are
 * created in the browser, so the id is minted here with the same alphabet as packages/domain newId; the server
 * validates the format.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newElementId(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 32];
  return `el_${time}${rand}`;
}
