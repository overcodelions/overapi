// Builds a fictional sandbox for README screenshots:
//   home/overapi/acme-*            APIs made the way the app makes them (`overapi import`)
//   home/overapi/acme-storefront   a workspace grouping three of them
//   home/code/acme-billing         a teammate's project, cloned: not approved yet
//   userData/                      settings and state.json pointing at all of it
//
// Every host is *.acme.example or localhost; every secret is a made-up
// value in a .env beside its project. Nothing here is real.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

// Usage: node seed.mjs <workDir> <userDataDir> <stubPort> [dark|light]
const [ROOT, USERDATA, PORT, THEME = 'dark'] = process.argv.slice(2);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const require = createRequire(import.meta.url);
const { trustFingerprint } = require(path.join(repo, 'dist', 'core', 'trust.js'));

const HOME = path.join(ROOT, 'home');
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(USERDATA, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });
const home = fs.realpathSync(HOME);
const apis = path.join(home, 'overapi');
const specs = path.join(ROOT, 'specs');
fs.mkdirSync(specs, { recursive: true });

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};

/// Imports a spec with the real CLI, then lets `edit` shape the project.
function importApi(spec, dir, edit, env = '') {
  const out = path.join(dir);
  execFileSync('node', [path.join(repo, 'dist', 'cli', 'index.js'), 'import', spec, '-o', out], { stdio: 'pipe', env: { ...process.env, HOME: home } });
  const file = path.join(out, 'overapi.json');
  const p = readJson(file);
  edit?.(p);
  delete p.source?.importedAt;
  if (p.source) p.source.ref = path.basename(spec);
  writeJson(file, p);
  if (env) fs.writeFileSync(path.join(out, '.env'), env);
  return file;
}

const tool = (p, name) => p.tools.find((t) => t.name === name);

// ---------------------------------------------------------------- Acme Orders

const LOCAL = `http://localhost:${PORT}/api/v1`;
const orders = importApi(
  path.join(repo, 'examples', 'acme-orders.openapi.yaml'),
  path.join(apis, 'acme-orders'),
  (p) => {
    p.envs[0].baseUrl = LOCAL;
    p.envs[0].allowWrites = true;
    p.instructions = 'Acme Orders is the storefront’s order book. Look a customer up first, then list their orders; totals are in USD.';
    p.examples = ['Which orders are still open?', 'What did Wile E. Coyote order last?', 'How much is in open orders for gold-tier customers?'];
    tool(p, 'list_orders').example = { status: 'open' };
  },
  'ACME_ORDERS_TOKEN=dev-token\n',
);

// ------------------------------------------------------------- Acme Accounts

const ACCOUNTS_SPEC = `
openapi: 3.0.3
info:
  title: Acme Accounts
  version: 1.8.0
  description: Sign-in and customer accounts for every Acme service.
servers:
  - url: http://localhost:4020/api
    description: local
  - url: https://accounts.staging.acme.example/api
    description: staging
  - url: https://accounts.acme.example/api
    description: production
paths:
  /auth/login:
    post:
      operationId: login
      summary: Sign in and get a session token
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [username, password]
              properties:
                username: { type: string }
                password: { type: string }
      responses:
        '200':
          description: A session
          content:
            application/json:
              schema:
                type: object
                properties:
                  token: { type: string }
                  expires_in: { type: integer }
  /accounts:
    get:
      operationId: listAccounts
      summary: List customer accounts
      parameters:
        - { name: tier, in: query, schema: { type: string, enum: [standard, gold] } }
        - { name: q, in: query, description: Name or email contains this., schema: { type: string } }
      responses: { '200': { description: Accounts } }
  /accounts/{accountId}:
    get:
      operationId: getAccount
      summary: One account, with its addresses
      parameters:
        - { name: accountId, in: path, required: true, schema: { type: integer } }
      responses: { '200': { description: An account } }
    patch:
      operationId: updateAccount
      summary: Change an account's tier or contact details
      parameters:
        - { name: accountId, in: path, required: true, schema: { type: integer } }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                tier: { type: string, enum: [standard, gold] }
                email: { type: string }
      responses: { '200': { description: The account } }
`;
fs.writeFileSync(path.join(specs, 'acme-accounts.openapi.yaml'), ACCOUNTS_SPEC.trimStart());
const accounts = importApi(
  path.join(specs, 'acme-accounts.openapi.yaml'),
  path.join(apis, 'acme-accounts'),
  (p) => {
    const login = tool(p, 'login');
    login.example = { username: '${ACME_USER}', password: '${ACME_PASSWORD}' };
    for (const e of p.envs) e.auth = { type: 'login', toolId: login.id, from: 'body', path: 'token', sendAs: 'bearer', refreshMinutes: 30 };
  },
  'ACME_USER=dana\nACME_PASSWORD=not-a-real-password\n',
);

// ------------------------------------------------------------ Acme Inventory (SOAP)

const inventory = importApi(path.join(repo, 'examples', 'acme-inventory.wsdl'), path.join(apis, 'acme-inventory'), (p) => {
  p.title = 'Acme Inventory';
  const base = p.envs[0];
  p.envs = [
    { ...base, name: 'local', baseUrl: 'http://localhost:8089' },
    { ...base, name: 'staging', baseUrl: 'https://inventory.staging.acme.example' },
    { ...base, name: 'production', baseUrl: 'https://inventory.acme.example' },
  ];
});

// The workspace: Accounts signs the other two in.
for (const f of [orders, inventory]) {
  const p = readJson(f);
  p.envs = p.envs.map((e) => (e.name === 'local' ? e : { ...e, auth: { type: 'via', api: 'acme-accounts', path: accounts } }));
  writeJson(f, p);
}
const storefront = path.join(apis, 'acme-storefront', 'overapi-system.json');
writeJson(storefront, {
  overapiSystem: 1,
  name: 'acme-storefront',
  title: 'Acme Storefront',
  description: 'The services behind the Acme storefront: accounts, orders and stock.',
  members: ['../acme-accounts/overapi.json', '../acme-orders/overapi.json', '../acme-inventory/overapi.json'],
  signedInBy: 'acme-accounts',
  instructions: 'Find the customer in Acme Accounts, then use their id with Acme Orders. Check stock in Acme Inventory before promising a date.',
});

// ------------------------------------------- Acme Billing: a teammate's clone

const BILLING_SPEC = `
openapi: 3.0.3
info:
  title: Acme Billing
  version: 0.9.2
  description: Invoices and refunds for Acme customers.
servers:
  - url: https://billing.staging.acme.example/v2
    description: staging
  - url: https://billing.acme.example/v2
    description: production
paths:
  /invoices:
    get:
      operationId: listInvoices
      summary: List invoices
      parameters:
        - { name: status, in: query, schema: { type: string, enum: [draft, open, paid, void] } }
      responses: { '200': { description: Invoices } }
  /invoices/{invoiceId}:
    get:
      operationId: getInvoice
      summary: One invoice with its lines
      parameters:
        - { name: invoiceId, in: path, required: true, schema: { type: string } }
      responses: { '200': { description: An invoice } }
    delete:
      operationId: voidInvoice
      summary: Void an invoice
      parameters:
        - { name: invoiceId, in: path, required: true, schema: { type: string } }
      responses: { '204': { description: Voided } }
  /refunds:
    post:
      operationId: createRefund
      summary: Refund part or all of a paid invoice
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                invoice_id: { type: string }
                amount: { type: number }
      responses: { '201': { description: The refund } }
`;
fs.writeFileSync(path.join(specs, 'acme-billing.openapi.yaml'), BILLING_SPEC.trimStart());
const billing = importApi(path.join(specs, 'acme-billing.openapi.yaml'), path.join(home, 'code', 'acme-billing'), (p) => {
  p.envs[0].auth = { type: 'bearer', tokenVar: 'ACME_BILLING_TOKEN' };
  p.envs[0].headers = { 'X-Acme-Tenant': '${ACME_TENANT_KEY}' };
  p.envs[1].auth = { type: 'command', commandVar: 'ACME_SSO_TOKEN_COMMAND', sendAs: 'bearer', refreshMinutes: 15 };
  // As it arrived: the delete isn't labelled destructive.
  tool(p, 'void_invoice').safety = 'write';
});

// ------------------------------- Acme Support: recorded from its web app, raw

const obj = (keys) => ({ t: 'object', keys });
const str = { t: 'string' };
const num = { t: 'number' };
const ticket = obj({ ticket_id: str, subject: str, status: str, requester_id: num, updated_at: str });
const ws = { name: 'workspace', in: 'path', required: true, schema: { type: 'string' } };
const tid = { name: 'ticket_id', in: 'path', required: true, schema: { type: 'string' } };
const recorded = (method, p, n, extra) => ({
  id: `${method} ${p}`,
  name: extra.name,
  description: `${method} ${p} — seen ${n} times in the capture.`,
  enabled: true,
  safety: method === 'GET' ? 'read' : 'write',
  method,
  path: p,
  bodyMode: method === 'GET' ? 'none' : 'json-fields',
  origin: { samples: n },
  ...extra,
});
const support = path.join(apis, 'acme-support', 'overapi.json');
writeJson(support, {
  overapi: 1,
  name: 'acme-support',
  title: 'Acme Support',
  description: 'Recorded from the Acme support desk web app.',
  version: '',
  source: { kind: 'har', ref: 'support.acme.example.har' },
  envs: [{ name: 'production', baseUrl: 'https://support.acme.example', auth: { type: 'bearer', tokenVar: 'ACME_SUPPORT_TOKEN' }, allowWrites: false }],
  tools: [
    recorded('GET', '/api/v2/{workspace}/tickets', 6, {
      name: 'get_api_v2_workspace_tickets',
      params: [ws, { name: 'status', in: 'query', required: false, schema: { type: 'string' } }, { name: 'updated>2026-11-01', in: 'query', required: false, schema: { type: 'string' } }],
      example: { workspace: 'acme-eu', status: 'open' },
      returns: obj({ data: { t: 'array', of: ticket }, next_cursor: str }),
    }),
    recorded('GET', '/api/v2/{workspace}/tickets/{ticket_id}', 4, {
      name: 'get_api_v2_workspace_tickets_ticket_id',
      params: [ws, tid],
      example: { workspace: 'acme-eu', ticket_id: 'T-4821' },
      returns: ticket,
    }),
    recorded('GET', '/api/v2/{workspace}/tickets/{ticket_id}/comments', 3, {
      name: 'get_api_v2_workspace_tickets_ticket_id_comments',
      params: [ws, tid],
      example: { workspace: 'acme-eu', ticket_id: 'T-4790' },
      returns: obj({ data: { t: 'array', of: obj({ comment_id: str, body: str, author: str }) } }),
    }),
    recorded('POST', '/api/v2/{workspace}/tickets/{ticket_id}/replies', 1, {
      name: 'post_api_v2_workspace_tickets_ticket_id_replies',
      params: [ws, tid, { name: 'body', in: 'body', required: true, schema: { type: 'string' } }],
      example: { workspace: 'acme-eu', ticket_id: 'T-4815', body: 'Thanks — a replacement anvil ships today.' },
    }),
    recorded('GET', '/api/v2/{workspace}/users/undefined', 2, { name: 'get_api_v2_workspace_users_undefined', params: [ws], example: { workspace: 'acme-eu' } }),
  ],
});
fs.writeFileSync(path.join(path.dirname(support), '.gitignore'), '.env\n');

// ---------------------------------------------------------------- app state

const projects = [orders, accounts, inventory, support, billing];
const trusted = {};
for (const f of [orders, accounts, inventory, support]) trusted[f] = trustFingerprint(readJson(f));
writeJson(path.join(USERDATA, 'state.json'), { projects, systems: [storefront], published: {}, installed: {}, trusted });
writeJson(path.join(USERDATA, 'settings.json'), {
  theme: THEME,
  ai: 'auto',
  aiModel: '',
  projectsDir: apis,
  timeoutSec: 30,
  autoUpdate: false,
  updateChannel: 'stable',
  loadTesting: false,
  toured: true,
});

writeJson(path.join(ROOT, 'seed-ids.json'), { home, orders, accounts, inventory, support, billing, storefront });
console.log(`seeded ${projects.length} APIs and a workspace in ${home}`);
