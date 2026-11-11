#!/usr/bin/env node
// A sample SOAP 1.1 service to try overapi's SOAP support on, with no
// dependencies: `node examples/acme-inventory-soap-server.mjs [port]`.
//
//   WSDL:      http://localhost:8089/soap/inventory?wsdl
//   Endpoint:  POST http://localhost:8089/soap/inventory
//   Sign-in:   WS-Security UsernameToken — user acme, password s3cret-pass
//
// Operations: ListItems, GetItem, AdjustStock, DeleteItem. Wrong
// credentials or an unknown SKU answer with a SOAP Fault, as real services do.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NS = 'urn:acme:inventory';
const USER = 'acme';
const PASSWORD = 's3cret-pass';

const seed = () => [
  { Sku: 'HAM-16', Name: 'Claw hammer, 16 oz', Category: 'tools', Quantity: 42, Price: '18.50' },
  { Sku: 'DRL-20', Name: 'Cordless drill, 20 V', Category: 'tools', Quantity: 7, Price: '129.00' },
  { Sku: 'BLT-M8', Name: 'Hex bolt M8 × 40 (box of 50)', Category: 'parts', Quantity: 310, Price: '9.75' },
  { Sku: 'TAP-48', Name: 'Duct tape, 48 mm', Category: 'supplies', Quantity: 0, Price: '6.20' },
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const envelope = (inner) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:inv="${NS}"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
const fault = (code, message) => envelope(`<soap:Fault><faultcode>soap:${code}</faultcode><faultstring>${esc(message)}</faultstring></soap:Fault>`);
const item = (i) => `<inv:Item><inv:Sku>${esc(i.Sku)}</inv:Sku><inv:Name>${esc(i.Name)}</inv:Name><inv:Category>${i.Category}</inv:Category><inv:Quantity>${i.Quantity}</inv:Quantity><inv:Price>${i.Price}</inv:Price><inv:UpdatedAt>2026-11-09T12:00:00Z</inv:UpdatedAt></inv:Item>`;

/// The text of the first element with this local name, any prefix.
const field = (xml, name) => {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${name}>`).exec(xml);
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim() : undefined;
};

export function createInventoryServer() {
  let items = seed();
  const wsdl = fs.readFileSync(path.join(here, 'acme-inventory.wsdl'), 'utf8');
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/soap/inventory') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not here. The service is at /soap/inventory (?wsdl for its description).');
    }
    if (req.method === 'GET') {
      // The WSDL, pointing at wherever this server is actually listening.
      res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
      return res.end(wsdl.replaceAll('http://localhost:8089/soap/inventory', `http://${req.headers.host}/soap/inventory`));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status, xml) => {
        res.writeHead(status, { 'content-type': 'text/xml; charset=utf-8' });
        res.end(xml);
      };
      if (field(body, 'Username') !== USER || field(body, 'Password') !== PASSWORD) {
        return send(500, fault('Client', 'Not authenticated: send a WS-Security UsernameToken (user acme).'));
      }
      const op = /<soap(?:env)?:Body[^>]*>\s*<(?:[\w-]+:)?(\w+)/i.exec(body)?.[1];
      const action = String(req.headers.soapaction ?? '').replace(/"/g, '');
      if (action && op && !action.endsWith(`/${op}`)) return send(500, fault('Client', `SOAPAction ${action} doesn't match the operation ${op}.`));
      const sku = field(body, 'Sku');
      const find = () => items.find((i) => i.Sku === sku);
      switch (op) {
        case 'ListItems': {
          const category = field(body, 'Category');
          const limit = Number(field(body, 'Limit') ?? 100);
          const list = items.filter((i) => !category || i.Category === category).slice(0, limit);
          return send(200, envelope(`<inv:ListItemsResponse>${list.map(item).join('')}</inv:ListItemsResponse>`));
        }
        case 'GetItem': {
          const i = find();
          if (!i) return send(500, fault('Client', `No item with SKU ${sku}.`));
          return send(200, envelope(`<inv:GetItemResponse>${item(i)}</inv:GetItemResponse>`));
        }
        case 'AdjustStock': {
          const i = find();
          if (!i) return send(500, fault('Client', `No item with SKU ${sku}.`));
          const delta = Number(field(body, 'Delta'));
          if (!Number.isInteger(delta)) return send(500, fault('Client', 'Delta must be a whole number.'));
          if (i.Quantity + delta < 0) return send(500, fault('Client', `Only ${i.Quantity} of ${sku} in stock.`));
          i.Quantity += delta;
          return send(200, envelope(`<inv:AdjustStockResponse><inv:Sku>${esc(i.Sku)}</inv:Sku><inv:Quantity>${i.Quantity}</inv:Quantity></inv:AdjustStockResponse>`));
        }
        case 'DeleteItem': {
          const before = items.length;
          items = items.filter((i) => i.Sku !== sku);
          return send(200, envelope(`<inv:DeleteItemResponse><inv:Deleted>${items.length < before}</inv:Deleted></inv:DeleteItemResponse>`));
        }
        default:
          return send(500, fault('Client', `Unknown operation ${op ?? '(none)'}.`));
      }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8089);
  createInventoryServer().listen(port, () => {
    process.stdout.write(`Acme Inventory (SOAP 1.1) on http://localhost:${port}/soap/inventory\n  WSDL: http://localhost:${port}/soap/inventory?wsdl\n  WS-Security: user ${USER}, password ${PASSWORD}\n`);
  });
}
