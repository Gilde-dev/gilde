import { createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';

import { WebhookController } from './webhook.controller.js';

const secret = 'test-secret';
const body = Buffer.from('{"zen":"hi"}');
const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const req = { rawBody: body } as never;

describe('WebhookController', () => {
    const controller = new WebhookController();
    const original = process.env.GITHUB_WEBHOOK_SECRET;

    beforeEach(() => { process.env.GITHUB_WEBHOOK_SECRET = secret; });
    afterAll(() => {
        if (original === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
        else process.env.GITHUB_WEBHOOK_SECRET = original;
    });

    it('answers a signed ping with pong', () => {
        expect(controller.github(req, sig, 'ping', 'd1')).toEqual({ result: 'pong' });
    });

    it('describes ignored events', () => {
        expect(controller.github(req, sig, 'push', 'd2')).toEqual({ result: 'ignored: event push' });
    });

    it('rejects a missing signature', () => {
        expect(() => controller.github(req, undefined, 'ping', 'd3')).toThrow(UnauthorizedException);
    });

    it('rejects a bad signature', () => {
        expect(() => controller.github(req, 'sha256=deadbeef', 'ping', 'd4')).toThrow(UnauthorizedException);
    });
});
