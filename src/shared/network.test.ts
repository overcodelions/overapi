import { describe, expect, it } from 'vitest';
import { isPrivateHost } from './network';

describe('isPrivateHost', () => {
  it('knows your own machines', () => {
    for (const u of ['http://localhost:4010', 'https://127.0.0.1/api', 'http://10.2.3.4', 'http://192.168.1.20:8080', 'http://172.20.0.5', 'http://orders.internal', 'http://api.local', 'http://buildbox:3000', 'http://[::1]:5000'])
      expect(isPrivateHost(u), u).toBe(true);
  });
  it('treats everything else as public', () => {
    for (const u of ['https://api.acme.example/v1', 'https://acme-pets.acme.example/api/v3', 'http://8.8.8.8', 'not a url']) expect(isPrivateHost(u), u).toBe(false);
  });
});
