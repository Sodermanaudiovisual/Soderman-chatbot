import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import { URL } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_DOMAIN = (process.env.COMPANY_DOMAIN || 'https://www.sodermanaudiovisual.com').replace(/\/+$/,'');
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES || 12);
const MAX_CHUNK_LEN = 900;   // chars
const MAX_CONTEXT_CHARS = 6000;

app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

// ---- OpenAI client ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Helpers ----
function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}
function normalize(url) {
  return new URL(url, SITE_DOMAIN).href.replace(/#.*$/,'');
}
function sameDomain(href) {
  try {
    const u = new URL(href, SITE_DOMAIN);
    return u.origin === new URL(SITE_DOMAIN).origin;
  } catch { return false; }
}
function chunkText(txt, maxLen) {
  const out = [];
  for (let i = 0; i < txt.length; i += maxLen) out.push(txt.slice(i, i + maxLen));
  return out;
}

// ---- Lightweight retrieval store ----
let KB_DOCS = []; // { url, text, chunks: [string] }

function scoreChunk(query, chunk) {
  const q = query.toLowerCase().split(/\W+/).filter(Boolean);
  const t = chunk.toLowerCase();
  let s = 0;
  for (const term of q) {
    if (term.length < 3) continue;
    const m = t.match(new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b','g'));
    if (m) s += m.length;
  }
  return s;
}
function retrieveContext(query, k=6) {
  const scored = [];
  for (const d of KB_DOCS) for (const c of d.chunks) scored.push({ url: d.url, text: c, score: scoreChunk(query, c) });
  scored.sort((a,b)=>b.score-a.score);
  const picked = scored.slice(0, Math.max(k,1)).filter(x=>x.score>0);
  let ctx = '', lines = [];
  for (const p of picked) {
    const remain = MAX_CONTEXT_CHARS - ctx.length;
    if (remain <= 0) break;
    const cut = p.text.slice(0, remain);
    lines.push('[Source] ' + p.url);
    lines.push(cut, '');
    ctx += cut + '\n';
  }
  return lines.join('\n').trim();
}

// ---- Crawler ----
async function httpGet(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36' }
  });
  return res;
}

async function extractLinks(baseUrl, html) {
  const hrefs = [];
  const rx = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const raw = m[1] || m[2] || m[3];
    if (!raw || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue;
    try {
      const abs = normalize(new URL(raw, baseUrl).href);
      if (sameDomain(abs)) hrefs.push(abs);
    } catch {}
  }
  return Array.from(new Set(hrefs)).filter(sameDomain);
}

async function crawlSite(startUrl) {
  const start = normalize(startUrl || SITE_DOMAIN);
  const seen = new Set();
  const queue = [start];
  const pages = [];

  while (queue.length && pages.length < MAX_PAGES) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await httpGet(url);
      const ctype = res.headers.get('content-type') || '';
      if (!res.ok || !ctype.includes('text/html')) continue;
      const html = await res.text();
      const text = stripHtml(html);
      const chunks = chunkText(text, MAX_CHUNK_LEN);
      pages.push({ url, text, chunks });
      const links = await extractLinks(url, html);
      for (const l of links) if (!seen.has(l) && l.startsWith(SITE_DOMAIN)) queue.push(l);
      console.log('• indexed:', url);
    } catch (e) {
      console.log('x skip:', url, String(e).slice(0,120));
    }
  }
  KB_DOCS = pages;
  return { pages: KB_DOCS.length };
}

// ---- UI ----
app.get('/', (_req, res) => {
  const html = [
    '<!doctype html><html lang="en"><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>SODERBOT</title>',
    '<style>',
    ':root { --brand:#0ea5e9; --bg:#0F1115; --fg:#E8EAF0; --muted:#9AA1AC; }',
    'body { margin:0; font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:#0b0c10; color:var(--fg); }',
    '#chat-launcher { position:fixed; bottom:20px; right:20px; width:56px; height:56px; border-radius:50%; background:var(--brand); color:#fff; display:grid; place-items:center; cursor:pointer; box-shadow:0 10px 30px rgba(0,0,0,.35); }',
    '#panel { position:fixed; bottom:90px; right:20px; width:360px; max-height:70vh; background:#111319; border:1px solid #222634; border-radius:16px; display:none; flex-direction:column; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,.45); }',
    'header { padding:12px 14px; background:#0e1118; border-bottom:1px solid #1f2430; display:flex; align-items:center; gap:8px; }',
    'header .dot { width:10px;height:10px;border-radius:50%;background:var(--brand); }',
    'header h1 { margin:0; font-size:14px; font-weight:600; color:#fff; }',
    '#log { padding:12px; display:flex; flex-direction:column; gap:8px; overflow:auto; }',
    '.msg { max-width:85%; padding:8px 10px; border-radius:10px; }',
    '.user { margin-left:auto; background:#1b2330; }',
    '.bot { margin-right:auto; background:#0f1723; border:1px solid #1f2937; }',
    '.muted { color:var(--muted); font-size:12px; padding:4px 8px; }',
    'form { display:flex; gap:8px; padding:12px; border-top:1px solid #1f2430; }',
    'input[type="text"] { flex:1; background:#0f1320; color:#fff; border:1px solid #22283a; border-radius:10px; padding:10px 12px; outline:none; }',
    'button { background:var(--brand); color:#fff; border:none; padding:10px 12px; border-radius:10px; cursor:pointer; }',
    '.handoff { background:#f59e0b; color:#111; border:none; padding:8px 10px; border-radius:10px; margin:6px 12px 12px auto; display:inline-block; }',
    '</style><body>',
    '<div id="chat-launcher" title="SODERBOT 💬">💬</div>',
    '<div id="panel"><header><div class="dot"></div><h1>SODERBOT</h1></header>',
    '<div id="log"></div>',
    '<form id="f"><input id="q" type="text" placeholder="Ask a question…" autocomplete="off" /><button>Send</button></form>',
    '</div>',
    '<script>',
    'const $panel=document.getElementById("panel"),$launch=document.getElementById("chat-launcher"),$log=document.getElementById("log"),$form=document.getElementById("f"),$q=document.getElementById("q");',
    'function add(role,text){const d=document.createElement("div");d.className="msg "+(role==="user"?"user":"bot");d.innerHTML=(text||"").replace(/\\n/g,"<br>");$log.appendChild(d);$log.scrollTop=$log.scrollHeight;}',
    'function addMuted(t){const p=document.createElement("div");p.className="muted";p.textContent=t;$log.appendChild(p);$log.scrollTop=$log.scrollHeight;}',
    'function addHandoffButton(){const b=document.createElement("button");b.className="handoff";b.textContent="Request a human";b.onclick=async()=>{const name=prompt("Your name?")||"",email=prompt("Email?")||"",phone=prompt("Phone (optional)?")||"",summary=prompt("Briefly describe your request:")||"Website chat handoff";try{const r=await fetch("/handoff",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,email,phone,summary})});if(!r.ok)throw new Error("handoff failed");alert("Thanks! Our team will reach out.");b.remove();}catch{alert("Sorry — could not notify a human right now.");}};$log.appendChild(b);$log.scrollTop=$log.scrollHeight;}',
    '$launch.onclick=()=>{$panel.style.display=($panel.style.display==="flex")?"none":"flex";if($panel.style.display==="flex")$q.focus();};',
    '$form.addEventListener("submit",async e=>{e.preventDefault();const text=$q.value.trim();if(!text)return;$q.value="";add("user",text);addMuted("Thinking…");try{const r=await fetch("/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:text})});const data=await r.json();const m=$log.querySelector(".muted:last-child");if(m)m.remove();add("assistant",data.reply||"(no answer)");addHandoffButton();}catch(err){const m=$log.querySelector(".muted:last-child");if(m)m.remove();add("assistant","Sorry — server error.");addHandoffButton();}});',
    '</script></body></html>'
  ].join('');
  res.type('html').send(html);
});

// ---- Crawl endpoints ----
app.post('/crawl', async (req, res) => {
  try {
    const target = (req.body && req.body.url) || SITE_DOMAIN;
    console.log('🔎 Manual crawl:', target);
    const out = await crawlSite(target);
    console.log('📚 Manual crawl pages:', out.pages);
    res.json({ ok: true, ...out, domain: SITE_DOMAIN });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});
app.get('/kb-status', (_req, res) => res.json({ pages: KB_DOCS.length, domain: SITE_DOMAIN }));

// ---- Chat API (with first-person "we" + context retrieval) ----
app.post('/chat', async (req, res) => {
  try {
    const message = (req.body && req.body.message) || '';
    if (!message) return res.status(400).json({ error: 'No message' });

    const context = retrieveContext(message);
    const sys = [
      'You are the website assistant for Soderman Audiovisual.',
      'Always answer in first person plural ("we / our") when referring to the company.',
      'Answer using the context below and general knowledge about video production.',
      'If a detail is missing, say you are not certain and offer to connect a human.',
      'Context:',
      context || '(No site context available. Keep answers general and suggest a human for specifics.)'
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: message }
      ]
    });

    const reply = completion.choices?.[0]?.message?.content || '(no reply)';
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Chat failed' });
  }
});

// ---- Handoff API ----
app.post('/handoff', async (req, res) => {
  try {
    const webhook = process.env.SUPPORT_WEBHOOK_URL;
    if (!webhook) return res.status(200).json({ ok: true, message: 'No webhook configured' });

    const { name='', email='', phone='', summary='' } = req.body || {};
    const payload = {
      text: [
        'Website chat: human requested',
        name ? '• Name: ' + name : null,
        email ? '• Email: ' + email : null,
        phone ? '• Phone: ' + phone : null,
        summary ? '• Summary: ' + summary : null
      ].filter(Boolean).join('\n')
    };

    const r = await fetch(webhook, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error('Webhook failed');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Handoff failed' });
  }
});

// ---- Auto daily crawl + startup crawl ----
const DAY_MS = 24 * 60 * 60 * 1000;
async function dailyCrawl() {
  try {
    console.log('🔎 Crawling:', SITE_DOMAIN, '(max', MAX_PAGES, 'pages)');
    const out = await crawlSite(SITE_DOMAIN);
    console.log('📚 Pages indexed:', out.pages);
  } catch (e) {
    console.error('⚠️ Crawl error:', String(e));
  }
}
dailyCrawl();                  // startup
setInterval(dailyCrawl, DAY_MS); // every 24h

app.listen(PORT, () => console.log('✅ Chatbot running on http://localhost:' + PORT));
