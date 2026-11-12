import { describe, expect, it } from 'vitest';
import { importOpenApi } from './openapi';
import { importPostman } from './postman';

describe('OpenAPI', () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'Acme Files', version: '1' },
    servers: [{ url: 'https://api.acme.test' }],
    components: {
      securitySchemes: {
        acmeAuth: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://auth.acme.test/token', scopes: { 'files:read': '', 'files:write': '' } } } },
      },
    },
    security: [{ acmeAuth: [] }],
    paths: {
      '/files': {
        post: {
          operationId: 'uploadFile',
          requestBody: {
            content: {
              'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, folder: { type: 'string' } } } },
            },
          },
          responses: { '201': { description: 'ok' } },
        },
      },
    },
  };

  it('reads an OAuth client-credentials flow and a multipart upload', () => {
    const p = importOpenApi(doc);
    expect(p.envs[0].auth).toMatchObject({ type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://auth.acme.test/token', scope: 'files:read files:write' });
    const t = p.tools[0];
    expect(t.bodyMode).toBe('multipart');
    expect(t.params.map((x) => [x.name, x.required, x.schema.format])).toEqual([
      ['file', true, 'binary'],
      ['folder', false, undefined],
    ]);
  });

  it('reads an authorization-code flow with its sign-in page', () => {
    const p = importOpenApi({
      ...doc,
      components: {
        securitySchemes: { acmeAuth: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: 'https://auth.acme.test/authorize', tokenUrl: 'https://auth.acme.test/token', scopes: {} } } } },
      },
    });
    expect(p.envs[0].auth).toMatchObject({ type: 'oauth2', grant: 'authorization_code', authUrl: 'https://auth.acme.test/authorize', scope: undefined });
  });
});

describe('Postman', () => {
  const collection = (auth: unknown) => ({
    info: { name: 'Acme', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    auth,
    item: [{ name: 'Orders', request: { method: 'GET', url: 'https://api.acme.test/orders' } }],
  });

  it('reads OAuth 2 settings, leaving secrets and {{variables}} out', () => {
    const p = importPostman(
      collection({
        type: 'oauth2',
        oauth2: [
          { key: 'grant_type', value: 'authorization_code_with_pkce' },
          { key: 'accessTokenUrl', value: 'https://auth.acme.test/token' },
          { key: 'authUrl', value: 'https://auth.acme.test/authorize' },
          { key: 'clientId', value: 'not-copied' },
          { key: 'scope', value: '{{scope}}' },
          { key: 'client_authentication', value: 'header' },
        ],
      }),
    );
    const a = p.envs[0].auth;
    expect(a).toMatchObject({
      type: 'oauth2',
      grant: 'authorization_code',
      tokenUrl: 'https://auth.acme.test/token',
      authUrl: 'https://auth.acme.test/authorize',
      scope: undefined,
      clientAuth: 'basic',
    });
    expect(JSON.stringify(p)).not.toContain('not-copied');
  });

  it('falls back to a bearer token for grants it cannot run', () => {
    const p = importPostman(collection({ type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'implicit' }] }));
    expect(p.envs[0].auth.type).toBe('bearer');
  });
});

describe('Postman GraphQL bodies', () => {
  it('keep the query, and its variables become arguments', () => {
    const p = importPostman({
      info: { name: 'Acme', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        {
          name: 'Order',
          request: {
            method: 'POST',
            url: 'https://api.acme.test/graphql',
            body: { mode: 'graphql', graphql: { query: 'query Order($id: ID!) { order(id: $id) { id } }', variables: '{ "id": "ord_1", "tenant": {{tenant}} }' } },
          },
        },
      ],
    });
    const t = p.tools[0];
    expect(t.bodyMode).toBe('graphql');
    expect(t.graphql).toEqual({ query: 'query Order($id: ID!) { order(id: $id) { id } }' });
    expect(t.params.map((x) => [x.name, x.schema.type])).toEqual([
      ['id', 'string'],
      ['tenant', undefined],
    ]);
  });
});
