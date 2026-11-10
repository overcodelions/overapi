// A small stand-in for a legacy API, so overapi can be tried end to end
// without a real one. Matches examples/acme-orders.openapi.yaml.
//
//   npm run example:server            # http://localhost:4010/api/v1
//   ACME_ORDERS_TOKEN=dev-token       # the token it accepts
//
// Data lives in memory and resets on restart.

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 4010);
const TOKEN = process.env.ACME_ORDERS_TOKEN ?? 'dev-token';
const PRICES = { 'ANVIL-1': 129.0, 'ROCKET-SKATES': 349.5, 'BIRDSEED-5KG': 18.75, 'TNT-CRATE': 89.99 };

const customers = [
  { id: 1, name: 'Wile E. Coyote', email: 'wile@acme.example', tier: 'gold' },
  { id: 2, name: 'Road Runner Logistics', email: 'ops@rr.example', tier: 'standard' },
];
let nextId = 1004;
const orders = [
  order(1001, 1, 'shipped', [{ sku: 'ANVIL-1', quantity: 2 }], 'Leave at the cliff edge'),
  order(1002, 1, 'open', [{ sku: 'ROCKET-SKATES', quantity: 1 }, { sku: 'BIRDSEED-5KG', quantity: 4 }], null),
  order(1003, 2, 'open', [{ sku: 'BIRDSEED-5KG', quantity: 10 }], 'Bulk — dock 3'),
];

function order(id, customer_id, status, items, note) {
  const lines = items.map((i) => ({ ...i, unit_price: PRICES[i.sku] ?? 10 }));
  const total = Math.round(lines.reduce((s, l) => s + l.unit_price * l.quantity, 0) * 100) / 100;
  return { id, customer_id, status, total, note, items: lines, created_at: new Date(Date.now() - (1010 - id) * 3_600_000).toISOString() };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/^\/api\/v1/, '');
  process.stdout.write(`${req.method} ${url.pathname}${url.search}\n`);

  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized', hint: 'Send Authorization: Bearer <ACME_ORDERS_TOKEN>' });

  let m;
  if (req.method === 'GET' && path === '/orders') {
    let list = [...orders].sort((a, b) => b.id - a.id);
    const status = url.searchParams.get('status');
    const customer = url.searchParams.get('customer_id');
    if (status) list = list.filter((o) => o.status === status);
    if (customer) list = list.filter((o) => o.customer_id === Number(customer));
    return send(res, 200, list.slice(0, Math.min(Number(url.searchParams.get('limit') ?? 20), 100)));
  }
  if (req.method === 'POST' && path === '/orders') {
    const body = await readJson(req);
    if (!body || !Number.isInteger(body.customer_id) || !Array.isArray(body.items) || !body.items.length) {
      return send(res, 400, { error: 'customer_id and a non-empty items list are required' });
    }
    if (!customers.some((c) => c.id === body.customer_id)) return send(res, 404, { error: `no customer ${body.customer_id}` });
    const o = order(nextId++, body.customer_id, 'open', body.items, body.note ?? null);
    orders.push(o);
    return send(res, 201, o);
  }
  if (req.method === 'POST' && path === '/orders/search') {
    const q = String((await readJson(req))?.q ?? '').toLowerCase();
    return send(res, 200, orders.filter((o) => (o.note ?? '').toLowerCase().includes(q) || o.items.some((i) => i.sku.toLowerCase().includes(q))));
  }
  if ((m = path.match(/^\/orders\/(\d+)$/))) {
    const i = orders.findIndex((o) => o.id === Number(m[1]));
    if (i === -1) return send(res, 404, { error: `no order ${m[1]}` });
    if (req.method === 'GET') return send(res, 200, orders[i]);
    if (req.method === 'DELETE') {
      orders.splice(i, 1);
      return send(res, 204);
    }
  }
  if (req.method === 'POST' && (m = path.match(/^\/orders\/(\d+)\/cancel$/))) {
    const o = orders.find((x) => x.id === Number(m[1]));
    if (!o) return send(res, 404, { error: `no order ${m[1]}` });
    if (o.status !== 'open') return send(res, 409, { error: `order ${o.id} is ${o.status}; only open orders can be cancelled` });
    o.status = 'cancelled';
    return send(res, 200, o);
  }
  if (req.method === 'GET' && (m = path.match(/^\/customers\/(\d+)$/))) {
    const c = customers.find((x) => x.id === Number(m[1]));
    return c ? send(res, 200, c) : send(res, 404, { error: `no customer ${m[1]}` });
  }
  send(res, 404, { error: `no route ${req.method} ${url.pathname}` });
});

server.listen(PORT, () => {
  process.stdout.write(`Acme Orders on http://localhost:${PORT}/api/v1 (token: ${TOKEN})\n`);
});
