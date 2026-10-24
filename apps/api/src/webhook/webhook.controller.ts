import { Body, Controller, Headers, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { WebhookService } from './webhook.service.js';
import { verifySignature } from './webhook-signature.js';

@Controller('/webhooks')
export class WebhookController {
    constructor(private readonly webhookService: WebhookService) { }

    private readonly logger = new Logger(WebhookController.name);

    @Post('/github')
    @HttpCode(200)
    async github(
        @Req() req: RawBodyRequest<Request>,
        @Headers('x-hub-signature-256') signature: string | undefined,
        @Headers('x-github-event') event: string | undefined,
        @Headers('x-github-delivery') delivery: string | undefined,
        @Body() payload?: unknown,
    ): Promise<{ result: string }> {
        if (!verifySignature(process.env.GITHUB_WEBHOOK_SECRET, req.rawBody, signature)) {
            this.logger.warn(`Rejected delivery ${delivery ?? '(no id)'}: bad or missing signature`);
            throw new UnauthorizedException('Invalid signature');
        }

        this.logger.log(`Delivery ${delivery ?? '(no id)'} event ${event ?? '(none)'}`);

        const id = delivery ?? '(no id)';
        if (event === 'ping') {
            this.logger.log(`Delivery ${id} ping: pong`);
            return { result: 'pong' };
        }
        const typed = payload as Parameters<WebhookService['handle']>[1];
        const result = await this.webhookService.handle(event, typed);
        const name = typed?.action ? `${event ?? '(none)'}.${typed.action}` : (event ?? '(none)');
        this.logger.log(`Delivery ${id} ${name}: ${result}`);
        return { result };
    }
}
