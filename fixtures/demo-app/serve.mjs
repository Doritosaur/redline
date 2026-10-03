// Demo site with deliberate performance problems, for testing Redline end to end.
//   node serve.mjs                    slow mode (default) on PORT or 4321
//   FIXTURE_MODE=fast node serve.mjs  same pages with the problems fixed
import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-z]:)/i, '$1'));
const dist = path.join(root, 'dist');
const fast = process.env.FIXTURE_MODE === 'fast';
const port = Number(process.env.PORT ?? 4321);

await build({
  entryPoints: [path.join(root, 'src/main.ts')],
  bundle: true,
  minify: true,
  sourcemap: 'linked',
  format: 'esm',
  target: 'es2022',
  outfile: path.join(dist, 'main.js'),
  logLevel: 'warning',
});
fs.copyFileSync(path.join(root, 'src/styles.css'), path.join(dist, 'styles.css'));
const heroBig = path.join(dist, 'hero-big.png');
const heroSmall = path.join(dist, 'hero-small.png');
if (!fs.existsSync(heroBig)) fs.writeFileSync(heroBig, noisePng(1600, 1200));
if (!fs.existsSync(heroSmall)) fs.writeFileSync(heroSmall, noisePng(400, 300));

const PAGES = {
  '/': 'Home',
  '/about': 'About us',
  '/products/1': 'Chair',
  '/products/2': 'Desk',
  '/products/3': 'Lamp',
};

function page(title) {
  const hero = fast
    ? '<img class="hero" src="/hero-small.png" width="400" height="300" alt="" fetchpriority="high">'
    : '<img class="hero" src="/hero-big.png" alt="">';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | Demo shop</title>
<link rel="stylesheet" href="/styles.css">
${fast ? '<script>window.FIXTURE_FAST = true</script><style>body{padding-top:5.5rem}.promo{position:fixed;top:0;left:0;right:0}</style>' : ''}
</head><body><div class="layout">
<h1>${title}</h1>
${hero}
<p>${'Quality furniture for every room. '.repeat(20)}</p>
<button id="add-to-cart">Add to cart</button> Cart: <span id="cart-count">0</span>
<button id="share">Share</button>
<ul id="products"></ul>
<nav>${Object.keys(PAGES).map((p) => `<a href="${p}">${PAGES[p]}</a>`).join(' · ')}</nav>
</div><script type="module" src="/main.js"></script></body></html>`;
}

const TYPES = { '.js': 'text/javascript', '.map': 'application/json', '.css': 'text/css', '.png': 'image/png' };

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (url.pathname in PAGES) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page(PAGES[url.pathname]));
    }
    if (url.pathname === '/sitemap.xml') {
      const locs = Object.keys(PAGES).map((p) => `<url><loc>http://localhost:${port}${p}</loc></url>`).join('');
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`);
    }
    const file = path.join(dist, path.normalize(url.pathname).replace(/^([\\/]\.\.)+/, ''));
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    // Slow, render-blocking stylesheet in slow mode.
    const delay = !fast && url.pathname === '/styles.css' ? 800 : 0;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    }, delay);
  })
  .listen(port, () => console.log(`demo-app (${fast ? 'fast' : 'slow'}) on http://localhost:${port}`));

/** Uncompressible RGB noise PNG, so the image is genuinely heavy. */
function noisePng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let i = 0; i < raw.length; i++) raw[i] = (i % (width * 3 + 1) === 0 ? 0 : (Math.random() * 256) | 0);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
