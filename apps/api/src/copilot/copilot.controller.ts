import { Controller, Get, Inject } from '@nestjs/common';

import type { CopilotConfig } from './copilot.config.js';
import { COPILOT_CONFIG } from './copilot.tokens.js';

export interface CopilotStatusDto {
    enabled: boolean;
    model: string | null;
}

@Controller('/v1/copilot')
export class CopilotController {
    constructor(@Inject(COPILOT_CONFIG) private readonly config: CopilotConfig) { }

    @Get('status')
    status(): CopilotStatusDto {
        return { enabled: this.config.enabled, model: this.config.model };
    }
}
