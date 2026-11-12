import { describe, expect, it } from 'vitest';
import { isLiteralValue, isSecretName, keepSecretsOut, secretVarName } from './secretNames';
import type { ToolDef } from './project';

describe('secret names', () => {
  it('knows a secret by its name, but not names that only look like one', () => {
    expect(['password', 'newPassword', 'passphrase', 'clientSecret', 'refresh_token', 'apiKey', 'api_key', 'pin', 'otp'].every(isSecretName)).toBe(true);
    expect(['tokenType', 'secretId', 'tokenUrl', 'passport', 'username', 'pinned', 'tokenExpiry'].some(isSecretName)).toBe(false);
  });

  it('tells a typed value from a reference to one kept elsewhere', () => {
    expect(isLiteralValue('hunter2')).toBe(true);
    expect([isLiteralValue('${ACME_PASSWORD}'), isLiteralValue('{{token}}'), isLiteralValue(''), isLiteralValue(42)]).toEqual([false, false, false, false]);
  });

  it('names the secret after the project and the field', () => {
    expect(secretVarName('ACME', 'password')).toBe('ACME_PASSWORD');
    expect(secretVarName('ACME', 'clientSecret')).toBe('ACME_CLIENT_SECRET');
    expect(secretVarName('ACME', 'api-key')).toBe('ACME_API_KEY');
  });
});

describe('keepSecretsOut', () => {
  const login: ToolDef = {
    id: 'POST /login',
    name: 'create_login',
    description: '',
    enabled: true,
    safety: 'write',
    method: 'POST',
    path: '/login',
    bodyMode: 'json-fields',
    params: [
      { name: 'username', in: 'body', required: true, schema: { type: 'string' } },
      { name: 'password', in: 'body', required: true, schema: { type: 'string' } },
      { name: 'clientKey', in: 'body', required: true, schema: { type: 'string' } },
    ],
  };

  it('swaps typed secrets for ${NAME} and hands back the values for the keychain', () => {
    expect(keepSecretsOut(login, { username: 'wile@acme.test', password: 'hunter2', clientKey: 'acme' }, 'ACME')).toEqual({
      args: { username: 'wile@acme.test', password: '${ACME_PASSWORD}', clientKey: 'acme' },
      secrets: [['ACME_PASSWORD', 'hunter2']],
    });
  });

  it('leaves references, and arguments that are not there, alone', () => {
    expect(keepSecretsOut(login, { password: '${ACME_PASSWORD}' }, 'ACME')).toEqual({ args: { password: '${ACME_PASSWORD}' }, secrets: [] });
    expect(keepSecretsOut(login, { username: 'x' }, 'ACME').secrets).toEqual([]);
  });
});
