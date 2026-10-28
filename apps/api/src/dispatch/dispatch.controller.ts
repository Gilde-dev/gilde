import { Controller, Get, Post } from '@nestjs/common';

import type { DispatchResult, DispatchStatus } from './dispatch.dto.js';
import { DispatcherService } from './dispatcher.service.js';

@Controller('/v1')
export class DispatchController {

    constructor(private readonly dispatcher: DispatcherService) { }

    @Get('dispatch/status')
    status(): DispatchStatus {
        return this.dispatcher.status();
    }

    @Post('dispatch')
    async dispatch(): Promise<DispatchResult> {
        return this.dispatcher.dispatch();
    }

}
