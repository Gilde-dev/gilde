import { createHmac } from 'node:crypto';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';

import type { WebhookService } from './webhook.service.js';
import { WebhookController } from './webhook.controller.js';

const secret = 'test-secret';
const body = Buffer.from('{"zen":"hi"}');
const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const req = { rawBody: body } as never;

describe('WebhookController', () => {
    const handle = vi.fn().mockResolvedValue('ignored: event push');
    const controller = new WebhookController({ handle } as unknown as WebhookService);
    const original = process.env.GITHUB_WEBHOOK_SECRET;

    beforeEach(() => { process.env.GITHUB_WEBHOOK_SECRET = secret; });
    afterAll(() => {
        if (original === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
        else process.env.GITHUB_WEBHOOK_SECRET = original;
    });

    it('answers a signed ping with pong', async () => {
        expect(await controller.github(req, sig, 'ping', 'd1')).toEqual({ result: 'pong' });
    });

    it('delegates other events to the service', async () => {
        expect(await controller.github(req, sig, 'push', 'd2', { a: 1 })).toEqual({ result: 'ignored: event push' });
        expect(handle).toHaveBeenCalledWith('push', { a: 1 });
    });

    it('logs delivery id, event.action and result', async () => {
        const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        await controller.github(req, sig, 'pull_request', 'd9', { action: 'edited' });
        expect(log).toHaveBeenCalledWith('Delivery d9 pull_request.edited: ignored: event push');
        log.mockRestore();
    });

    it('rejects a missing signature', async () => {
        await expect(controller.github(req, undefined, 'ping', 'd3')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a bad signature', async () => {
        await expect(controller.github(req, 'sha256=deadbeef', 'ping', 'd4')).rejects.toBeInstanceOf(UnauthorizedException);
    });
});
