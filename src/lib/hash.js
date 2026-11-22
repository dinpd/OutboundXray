// Hashes used by trackers to "anonymise" emails and phone numbers. SHA hashes
// come from WebCrypto; MD5 is not in WebCrypto, so it is implemented here.

const encoder = new TextEncoder();

function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function shaHex(algorithm, text) {
  const digest = await crypto.subtle.digest(algorithm, encoder.encode(text));
  return toHex(new Uint8Array(digest));
}

const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

export function md5Hex(text) {
  const bytes = encoder.encode(text);
  const len = bytes.length;
  const blocks = ((len + 8) >> 6) + 1;
  const words = new Uint32Array(blocks * 16);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[len >> 2] |= 0x80 << ((len % 4) * 8);
  words[blocks * 16 - 2] = (len * 8) >>> 0;
  words[blocks * 16 - 1] = Math.floor((len * 8) / 2 ** 32);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let block = 0; block < blocks; block++) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      f = (f + a + MD5_K[i] + words[block * 16 + g]) >>> 0;
      a = d; d = c; c = b;
      const s = MD5_S[(i >> 4) * 4 + (i % 4)];
      b = (b + ((f << s) | (f >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = [];
  for (const w of [a0, b0, c0, d0]) for (let s = 0; s < 32; s += 8) out.push((w >>> s) & 255);
  return toHex(out);
}
