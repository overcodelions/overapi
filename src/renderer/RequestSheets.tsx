import { useState } from 'react';
import { useStore } from './store';
import { Sheet } from './ui';
import { toolId, type HttpMethod, type ParamDef } from '@shared/project';
import { nameFromRoute } from '@shared/naming';
import { safetyFor } from '@shared/safety';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function NewRequestSheet(): JSX.Element {
  const { openSheet, addTool, project, env } = useStore();
  const [method, setMethod] = useState<HttpMethod>('GET');
  const [path, setPath] = useState('/');
  const base = project?.envs.find((e) => e.name === env)?.baseUrl;

  const create = () => {
    let clean = path.trim() || '/';
    if (/^https?:\/\//i.test(clean) && base && clean.startsWith(base)) clean = clean.slice(base.replace(/\/+$/, '').length) || '/';
    if (!clean.startsWith('/')) clean = `/${clean}`;
    const params: ParamDef[] = [...clean.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    addTool({
      id: toolId(method, clean),
      name: nameFromRoute(method, clean),
      description: '',
      // A request first: you try it, then make it a tool when it works.
      enabled: false,
      safety: safetyFor(method, clean),
      method,
      path: clean,
      params,
      bodyMode: method === 'GET' || method === 'DELETE' ? 'none' : 'json-fields',
    });
    openSheet(null);
  };

  return (
    <Sheet
      title="New request"
      onClose={() => openSheet(null)}
      footer={
        <>
          <button className="btn" onClick={() => openSheet(null)}>Cancel</button>
          <button className="btn-primary" onClick={create}>Add request</button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <div className="flex gap-2">
          <select className="field w-28 font-mono" value={method} onChange={(e) => setMethod(e.target.value as HttpMethod)}>
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input className="field font-mono" autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="/orders/{orderId}" />
        </div>
        <p className="mt-2 text-[12px] text-ink-muted">
          The path after the environment’s base URL{base ? <> (<span className="font-mono">{base}</span>)</> : ''}. Write <span className="font-mono">{'{name}'}</span> for each value in the path —
          it becomes an argument. Query, header and body arguments are added on the request.
        </p>
      </form>
    </Sheet>
  );
}

export function CurlSheet(): JSX.Element {
  const { openSheet, addCurl } = useStore();
  const [text, setText] = useState('');
  return (
    <Sheet
      title="Paste a cURL"
      wide
      onClose={() => openSheet(null)}
      footer={
        <>
          <button className="btn" onClick={() => openSheet(null)}>Cancel</button>
          <button className="btn-primary" disabled={!text.trim()} onClick={async () => (await addCurl(text)) && openSheet(null)}>Add request</button>
        </>
      }
    >
      <CurlHelp />
      <textarea className="field mt-3 min-h-[180px] font-mono text-[12px]" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={"curl 'https://orders.acme.example/api/v1/orders?status=open' \\\n  -H 'Authorization: Bearer …'"} />
    </Sheet>
  );
}

export function CurlHelp(): JSX.Element {
  return (
    <p className="text-[12px] leading-relaxed text-ink-muted">
      In the browser’s developer tools, open Network, right-click a call and choose <b>Copy → Copy as cURL</b>. Ids in the path become arguments, the query and JSON body become
      arguments with the values you sent as the example, and any token or API key goes to the keychain — never into the project file.
    </p>
  );
}
