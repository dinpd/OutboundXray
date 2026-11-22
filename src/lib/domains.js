// Works out the "site" (registrable domain) a host belongs to, so that
// shop.example.co.uk and cdn.example.co.uk count as the same site.
//
// This is a compact heuristic, not the full Public Suffix List: it knows the
// common two-part country suffixes and popular hosting platforms where every
// subdomain belongs to a different owner. Unknown multi-part suffixes fall back
// to the last two labels.

const MULTI_PART_SUFFIXES = new Set([
  // Country second-level domains
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'net.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'co.kr', 'or.kr',
  'com.br', 'net.br', 'org.br',
  'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.cn', 'com.hk', 'com.sg',
  'com.tw', 'com.tr', 'com.ua', 'com.my', 'com.ph', 'com.vn', 'com.pk',
  'com.eg', 'com.sa', 'com.ng',
  'co.in', 'net.in', 'org.in', 'co.za', 'co.il', 'org.il', 'co.id', 'co.th',
  // Hosting platforms (each subdomain is a different owner)
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app',
  'netlify.app', 'herokuapp.com', 'web.app', 'firebaseapp.com', 'appspot.com',
  'blogspot.com', 'azurewebsites.net', 'cloudfront.net', 'fly.dev',
  'onrender.com', 'glitch.me', 'repl.co', 'wordpress.com', 'myshopify.com',
  'translate.goog',
]);

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function registrableDomain(host) {
  const h = (host || '').toLowerCase().replace(/\.$/, '');
  if (!h || /^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join('.');
  const take = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return parts.slice(-take).join('.');
}
