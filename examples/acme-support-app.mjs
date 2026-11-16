// A sample web app with no public API: the Acme Support desk.
//
// One page, and the private JSON API it calls behind it — the kind of
// system overapi's recorder is for. Open it in Record traffic › Browser,
// sign in, click around, and build an API from what it called.
//
//   npm run example:webapp      # http://localhost:4030
//
// Sign in with any email and the password "demo". Everything here is
// fictional and kept in memory.

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 4030);
const WS = 'acme-eu';
const sessions = new Map();

const users = [
  { id: 101, name: 'Dana Whitfield', email: 'dana@acme.example', team: 'Tier 1', role: 'agent' },
  { id: 214, name: 'Priya Natarajan', email: 'priya@northwind.example', org: 'Northwind Trading', plan: 'Business' },
  { id: 233, name: 'Marco Bellini', email: 'marco@bellini-tools.example', org: 'Bellini Tools', plan: 'Starter' },
  { id: 251, name: 'Hana Sato', email: 'hana@kitsune.example', org: 'Kitsune Labs', plan: 'Enterprise' },
  { id: 268, name: 'Tom Okafor', email: 'tom@okafor-logistics.example', org: 'Okafor Logistics', plan: 'Business' },
  { id: 274, name: 'Lena Fischer', email: 'lena@fischer-bau.example', org: 'Fischer Bau', plan: 'Starter' },
];
const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const tickets = [
  { ticket_id: 'T-4821', subject: 'Export to CSV drops the last row', status: 'open', priority: 'high', requester_id: 214, assignee_id: 101, updated_at: ago(0.4), tags: ['exports', 'bug'] },
  { ticket_id: 'T-4819', subject: 'SSO login loops back to the sign-in page', status: 'open', priority: 'urgent', requester_id: 251, assignee_id: 101, updated_at: ago(1.2), tags: ['sso'] },
  { ticket_id: 'T-4815', subject: 'Replacement order arrived damaged', status: 'pending', priority: 'normal', requester_id: 233, assignee_id: 101, updated_at: ago(3), tags: ['shipping'] },
  { ticket_id: 'T-4812', subject: 'Invoice shows the wrong VAT number', status: 'open', priority: 'normal', requester_id: 274, assignee_id: null, updated_at: ago(5), tags: ['billing'] },
  { ticket_id: 'T-4808', subject: 'Webhook retries stopped on Tuesday', status: 'open', priority: 'high', requester_id: 268, assignee_id: 101, updated_at: ago(8), tags: ['webhooks'] },
  { ticket_id: 'T-4801', subject: 'How do I add a second warehouse?', status: 'pending', priority: 'low', requester_id: 214, assignee_id: null, updated_at: ago(20), tags: ['how-to'] },
  { ticket_id: 'T-4790', subject: 'Bulk price update timed out', status: 'solved', priority: 'normal', requester_id: 251, assignee_id: 101, updated_at: ago(30), tags: ['catalog'] },
  { ticket_id: 'T-4786', subject: 'Need a copy of our 2025 contract', status: 'solved', priority: 'low', requester_id: 233, assignee_id: 101, updated_at: ago(44), tags: ['account'] },
];
const comments = {
  'T-4821': [
    { comment_id: 'c-9001', author_id: 214, body: 'Every export is one row short. Tried two browsers — same result.', created_at: ago(26) },
    { comment_id: 'c-9004', author_id: 101, body: 'Reproduced on our side with a 250-row report. Passing it to engineering now.', created_at: ago(2) },
    { comment_id: 'c-9007', author_id: 214, body: 'Thanks! Any workaround in the meantime?', created_at: ago(0.4) },
  ],
  'T-4819': [{ comment_id: 'c-8990', author_id: 251, body: 'After the IdP certificate rotation, everyone lands back on the sign-in page.', created_at: ago(1.2) }],
};

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/html; charset=utf-8', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let s = '';
  for await (const c of req) s += c;
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  // Feels like a real backend: a little latency, varied.
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 160));

  if (req.method === 'GET' && (p === '/' || p.startsWith('/tickets'))) return send(res, 200, PAGE);

  if (req.method === 'POST' && p === '/api/auth/session') {
    const { email, password } = await readBody(req);
    if (!email || password !== 'demo') return send(res, 401, { error: { message: 'Email or password is wrong.' } });
    const token = `ses_${crypto.randomBytes(18).toString('hex')}`;
    sessions.set(token, users[0]);
    return send(res, 201, { token, expires_in: 3600, user: { id: users[0].id, name: users[0].name } });
  }

  const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
  const me = sessions.get(auth);
  const api = p.match(/^\/api\/v2\/([^/]+)(\/.*)$/);
  if (!api) return send(res, 404, { error: { message: 'Not found.' } });
  if (!me) return send(res, 401, { error: { message: 'Sign in first.' } });
  if (api[1] !== WS) return send(res, 404, { error: { message: `No workspace ${api[1]}.` } });
  const rest = api[2];
  let m;

  if (req.method === 'GET' && rest === '/me') return send(res, 200, { ...me, workspace: WS });
  if (req.method === 'GET' && rest === '/views') {
    const count = (s) => tickets.filter((t) => t.status === s).length;
    return send(res, 200, { data: [{ id: 'open', title: 'Open', count: count('open') }, { id: 'pending', title: 'Pending', count: count('pending') }, { id: 'solved', title: 'Solved', count: count('solved') }] });
  }
  if (req.method === 'GET' && rest === '/tickets') {
    const status = url.searchParams.get('status');
    const data = tickets.filter((t) => !status || t.status === status).map((t) => ({ ...t, requester: users.find((u) => u.id === t.requester_id)?.name }));
    return send(res, 200, { data, next_cursor: null });
  }
  if (req.method === 'GET' && (m = rest.match(/^\/tickets\/([^/]+)$/))) {
    const t = tickets.find((x) => x.ticket_id === m[1]);
    return t ? send(res, 200, t) : send(res, 404, { error: { message: `No ticket ${m[1]}.` } });
  }
  if (req.method === 'GET' && (m = rest.match(/^\/tickets\/([^/]+)\/comments$/))) return send(res, 200, { data: comments[m[1]] ?? [] });
  if (req.method === 'POST' && (m = rest.match(/^\/tickets\/([^/]+)\/replies$/))) {
    const { body } = await readBody(req);
    const c = { comment_id: `c-${9100 + Math.floor(Math.random() * 800)}`, author_id: me.id, body: String(body ?? ''), created_at: new Date().toISOString() };
    (comments[m[1]] ??= []).push(c);
    return send(res, 201, c);
  }
  if (req.method === 'GET' && (m = rest.match(/^\/users\/(\d+)$/))) {
    const u = users.find((x) => x.id === Number(m[1]));
    return u ? send(res, 200, u) : send(res, 404, { error: { message: `No user ${m[1]}.` } });
  }
  return send(res, 404, { error: { message: 'Not found.' } });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Acme Support web app on http://localhost:${PORT} — sign in with any email and the password "demo"`));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Acme Support</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--ink:#1d2433;--muted:#5d6577;--faint:#8a91a1;--rule:#e6e8ee;--wash:#f5f6f9;--brand:#0f766e;--brand-soft:#ccfbf1}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,system-ui,sans-serif;color:var(--ink);background:#fff}
button{font:inherit;cursor:pointer}
.login{display:grid;place-items:center;height:100vh;background:linear-gradient(160deg,#ecfdf5,#f8fafc)}
.card{width:360px;background:#fff;border:1px solid var(--rule);border-radius:14px;padding:28px;box-shadow:0 10px 30px rgba(15,23,42,.08)}
.logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:17px}.logo i{width:24px;height:24px;border-radius:7px;background:var(--brand);display:inline-block}
label{display:block;font-size:12px;color:var(--muted);margin:14px 0 4px}input{width:100%;padding:9px 11px;border:1px solid var(--rule);border-radius:8px;font:inherit}
.primary{width:100%;margin-top:18px;padding:10px;border:0;border-radius:8px;background:var(--brand);color:#fff;font-weight:600}
.app{display:grid;grid-template-columns:210px 1fr 380px;height:100vh}
nav{background:#0f172a;color:#cbd5e1;padding:16px 10px}nav .logo{color:#fff;padding:2px 8px 18px}
nav button{display:flex;justify-content:space-between;width:100%;padding:8px 10px;border:0;border-radius:7px;background:none;color:inherit;text-align:left}
nav button.on{background:#1e293b;color:#fff}nav small{color:#64748b}
.list{border-right:1px solid var(--rule);overflow:auto}.list h2{margin:0;padding:18px 20px 12px;font-size:18px}
.row{display:grid;grid-template-columns:70px 1fr auto;gap:10px;align-items:center;padding:12px 20px;border-top:1px solid var(--rule);cursor:pointer}
.row:hover{background:var(--wash)}.row.on{background:#f0fdfa}.id{font:12px ui-monospace,monospace;color:var(--faint)}
.subj{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.who{font-size:12px;color:var(--muted)}
.pill{font-size:11px;padding:2px 8px;border-radius:99px;background:var(--wash);color:var(--muted);text-transform:capitalize}
.pill.urgent{background:#fee2e2;color:#b91c1c}.pill.high{background:#ffedd5;color:#c2410c}
.detail{overflow:auto;padding:20px;background:var(--wash)}.detail h3{margin:4px 0 14px;font-size:16px}
.who-card{background:#fff;border:1px solid var(--rule);border-radius:10px;padding:12px;margin-bottom:14px;font-size:13px}
.c{background:#fff;border:1px solid var(--rule);border-radius:10px;padding:10px 12px;margin-bottom:8px}.c b{font-size:12px}.c p{margin:4px 0 0}
.empty{color:var(--faint);padding:40px 0;text-align:center}
</style></head><body><div id="root"></div>
<script>
const WS='${WS}';let token=null,me=null,view='open',sel=null,people={};
const $=(h)=>{document.getElementById('root').innerHTML=h};
const api=async(path,opts={})=>{const r=await fetch('/api/v2/'+WS+path,{...opts,headers:{'content-type':'application/json',authorization:'Bearer '+token}});return r.json()};
const esc=(s)=>String(s??'').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function login(){$('<div class="login"><form class="card" id="login"><div class="logo"><i></i>Acme Support</div><label>Email</label><input name="email" value="dana@acme.example"><label>Password</label><input name="password" type="password" value="demo"><button class="primary">Sign in</button></form></div>');
 document.getElementById('login').onsubmit=async(e)=>{e.preventDefault();const f=new FormData(e.target);const r=await fetch('/api/auth/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:f.get('email'),password:f.get('password')})});const j=await r.json();if(!r.ok)return alert(j.error.message);token=j.token;me=await api('/me');load()}}
async function load(){const [views,list]=await Promise.all([api('/views'),api('/tickets?status='+view)]);render(views.data,list.data)}
async function pick(id){sel=id;document.querySelectorAll('.row').forEach((r)=>r.classList.toggle('on',r.dataset.id===id));
 const t=await api('/tickets/'+id);const [cs,req]=await Promise.all([api('/tickets/'+id+'/comments'),api('/users/'+t.requester_id)]);people[req.id]=req;people[me.id]=me;
 document.getElementById('detail').innerHTML='<span class="id">'+esc(t.ticket_id)+'</span><h3>'+esc(t.subject)+'</h3><div class="who-card"><b>'+esc(req.name)+'</b><div class="who">'+esc(req.org)+' · '+esc(req.plan)+' plan</div><div class="who">'+esc(req.email)+'</div></div>'+(cs.data.length?cs.data.map((c)=>'<div class="c"><b>'+esc(people[c.author_id]?.name??'Customer')+'</b><p>'+esc(c.body)+'</p></div>').join(''):'<div class="empty">No comments yet.</div>')}
function render(views,list){$('<div class="app"><nav><div class="logo"><i></i>Acme Support</div>'+views.map((v)=>'<button class="'+(v.id===view?'on':'')+'" data-view="'+v.id+'">'+v.title+' <small>'+v.count+'</small></button>').join('')+'</nav><section class="list"><h2>'+views.find((v)=>v.id===view).title+' tickets</h2>'+list.map((t)=>'<div class="row" data-id="'+t.ticket_id+'"><span class="id">'+t.ticket_id+'</span><span><div class="subj">'+esc(t.subject)+'</div><div class="who">'+esc(t.requester)+'</div></span><span class="pill '+t.priority+'">'+t.priority+'</span></div>').join('')+'</section><aside class="detail" id="detail"><div class="empty">Pick a ticket.</div></aside></div>');
 document.querySelectorAll('nav button').forEach((b)=>b.onclick=()=>{view=b.dataset.view;sel=null;load()});document.querySelectorAll('.row').forEach((r)=>r.onclick=()=>pick(r.dataset.id))}
login();
</script></body></html>`;
