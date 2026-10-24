import { Controller, Post } from '@nestjs/common';

import { DispatcherService } from './dispatcher.service.js';

@Controller('/v1')
export class DispatchController {

    constructor(private readonly dispatcher: DispatcherService) { }

    @Post('dispatch')
    async dispatch(): Promise<{ fired: number }> {
        return { fired: await this.dispatcher.dispatch() };
    }

}
