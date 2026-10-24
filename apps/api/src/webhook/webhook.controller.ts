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

        if (event === 'ping') return { result: 'pong' };
        return { result: await this.webhookService.handle(event, payload as Parameters<WebhookService['handle']>[1]) };
    }
}
