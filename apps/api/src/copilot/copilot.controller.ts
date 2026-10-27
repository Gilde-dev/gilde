import { Controller, Get, Inject, Optional } from '@nestjs/common';

import type { CopilotConfig } from './copilot.config.js';
import { COPILOT_CONFIG, SCOUT_SETUP } from './copilot.tokens.js';
import type { ScoutSetup } from './copilot.mastra.js';

export interface CopilotStatusDto {
    enabled: boolean;
    model: string | null;
    /** The unattended scout (Verkenner), configured separately from the co-pilot. */
    scout: { enabled: boolean; model: string | null };
}

@Controller('/v1/copilot')
export class CopilotController {
    constructor(
        @Inject(COPILOT_CONFIG) private readonly config: CopilotConfig,
        @Optional() @Inject(SCOUT_SETUP) private readonly scout: ScoutSetup | null = null,
    ) { }

    @Get('status')
    status(): CopilotStatusDto {
        return {
            enabled: this.config.enabled,
            model: this.config.model,
            scout: { enabled: this.scout !== null, model: this.scout?.config.model ?? null },
        };
    }
}
