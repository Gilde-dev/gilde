import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { configureProxy } from './proxy.js';

describe('configureProxy', () => {
  it('trusts exactly one proxy hop', async () => {
    const server = express();
    configureProxy(server as never);
    server.get('/ip', (req, res) => {
      res.json({ ip: req.ip });
    });
    const res = await request(server).get('/ip').set('X-Forwarded-For', '198.51.100.1, 203.0.113.7');
    expect(res.body.ip).toBe('203.0.113.7');
  });
});
