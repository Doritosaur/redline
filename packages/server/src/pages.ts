const BASE_CSS = `
:root{--bg:#f7f7f5;--card:#fff;--fg:#1c1c1a;--muted:#6b6b66;--line:#e4e3de;--accent:#d92d20;--err:#c4261d;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1d1d1b;--fg:#ecebe6;--muted:#a3a29b;--line:#33332f;--accent:#ff6b5e;--err:#ff7a70;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:40rem;margin:0 auto;padding:4rem 1rem}
.brand{font-weight:700;font-size:1.4rem;display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem}.mark{width:1.6rem;height:.32rem;background:var(--accent);border-radius:2px}
p{color:var(--muted)}form{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.25rem;display:grid;gap:.9rem;margin-top:1.5rem}
label{font-weight:600;font-size:.9rem;display:grid;gap:.35rem}input,select{font:inherit;padding:.6rem .7rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);width:100%}
.row{display:flex;gap:.9rem;flex-wrap:wrap}.row label{flex:1 1 8rem}
button{font:inherit;font-weight:600;padding:.7rem 1rem;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}button:disabled{opacity:.6;cursor:wait}
.err{color:var(--err);min-height:1.5em;margin:0}
`;

export function landingPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redline</title><style>${BASE_CSS}</style></head><body><main>
<div class="brand"><span class="mark" aria-hidden="true"></span>Redline</div>
<p>Find out what's slowing your page down: Core Web Vitals, ranked fixes with estimated savings, and the code responsible.</p>
<form id="f">
  <label>Page URL<input name="url" type="url" required placeholder="https://example.com" autocomplete="url"></label>
  <div class="row">
    <label>Device<select name="preset"><option value="mobile">Mobile</option><option value="desktop">Desktop</option></select></label>
    <label>Runs<select name="runs"><option>1</option><option selected>3</option></select></label>
  </div>
  <button>Audit</button>
  <p class="err" id="err" role="alert"></p>
</form>
</main>
<script>
const f = document.getElementById('f'), err = document.getElementById('err');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  const button = f.querySelector('button');
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(f));
    const res = await fetch('/api/audits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data, runs: Number(data.runs) }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Something went wrong');
    location.href = body.reportUrl;
  } catch (e) {
    err.textContent = e.message;
    button.disabled = false;
  }
});
</script></body></html>`;
}

export function pendingPage(message: string, refresh: boolean): string {
  const esc = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="3">' : ''}<title>Redline</title><style>${BASE_CSS}</style></head><body><main>
<div class="brand"><span class="mark" aria-hidden="true"></span>Redline</div><p>${esc}</p><p><a href="/" style="color:var(--accent)">New audit</a></p>
</main></body></html>`;
}
