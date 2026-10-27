import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import type { CopilotConfig } from './copilot.config.js';
import { COPILOT_CONFIG, SCOUT_SETUP } from './copilot.tokens.js';
import type { ScoutSetup } from './copilot.mastra.js';
import { ScoutActivityQuerySchema, ScoutActivityService, type ScoutActivityDto } from './scout-activity.service.js';

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
        @Optional() private readonly activity?: ScoutActivityService,
    ) { }

    @Get('status')
    status(): CopilotStatusDto {
        return {
            enabled: this.config.enabled,
            model: this.config.model,
            scout: { enabled: this.scout !== null, model: this.scout?.config.model ?? null },
        };
    }

    /** What the scout did in one project: for the metrics page and the creator comparison of the board's Suggested badge. */
    @Get('scout-activity')
    scoutActivity(@Query(new ZodValidationPipe(ScoutActivityQuerySchema)) q: { projectId: string }): Promise<ScoutActivityDto> {
        return this.activity!.get(q.projectId);
    }
}
