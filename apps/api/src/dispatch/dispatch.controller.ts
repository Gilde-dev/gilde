import { Controller, Post } from '@nestjs/common';

import { type DispatchResult, DispatcherService } from './dispatcher.service.js';

@Controller('/v1')
export class DispatchController {

    constructor(private readonly dispatcher: DispatcherService) { }

    @Post('dispatch')
    async dispatch(): Promise<DispatchResult> {
        return this.dispatcher.dispatch();
    }

}
