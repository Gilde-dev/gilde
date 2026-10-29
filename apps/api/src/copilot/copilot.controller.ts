import { Controller, Get, Inject, Optional, Param, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import type { CopilotConfig } from './copilot.config.js';
import { COPILOT_CONFIG, REFINE_SETUP, SCOUT_SETUP } from './copilot.tokens.js';
import type { RefineSetup, ScoutSetup } from './copilot.mastra.js';
import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CopilotThreadsService } from './copilot-threads.service.js';
import { ScoutActivityQuerySchema, type CopilotThreadDto, type CopilotThreadMessagesDto, type CopilotStatusDto, type ScoutActivityDto, type ScoutActivityQuery } from './copilot.dto.js';
import { ScoutActivityService } from './scout-activity.service.js';

@Controller('/v1/copilot')
export class CopilotController {
    constructor(
        @Inject(COPILOT_CONFIG) private readonly config: CopilotConfig,
        @Optional() @Inject(SCOUT_SETUP) private readonly scout: ScoutSetup | null = null,
        @Optional() @Inject(REFINE_SETUP) private readonly refine: RefineSetup | null = null,
        @Optional() private readonly activity?: ScoutActivityService,
        @Optional() private readonly threads?: CopilotThreadsService,
    ) { }

    @Get('status')
    status(): CopilotStatusDto {
        return {
            enabled: this.config.enabled,
            model: this.config.model,
            scout: { enabled: this.scout !== null, model: this.scout?.config.model ?? null },
            refine: { enabled: this.refine !== null, model: this.refine?.config.model ?? null },
        };
    }

    /** What the scout did in one project: for the metrics page and the creator comparison of the board's Suggested badge. */
    @Get('scout-activity')
    scoutActivity(@Query(new ZodValidationPipe(ScoutActivityQuerySchema)) q: ScoutActivityQuery): Promise<ScoutActivityDto> {
        return this.activity!.get(q.projectId);
    }

    /** The caller's own co-pilot conversations, newest first. The user comes from the token, never from input. */
    @Get('threads')
    listThreads(@CurrentUser() user: AuthUser | null): Promise<CopilotThreadDto[]> {
        return user ? this.threads!.list(user.id) : Promise.resolve([]);
    }

    /** The messages of one of the caller's conversations; 404 for any other thread. */
    @Get('threads/:id/messages')
    threadMessages(@CurrentUser() user: AuthUser | null, @Param('id') id: string): Promise<CopilotThreadMessagesDto> {
        return this.threads!.messages(user?.id ?? '', id);
    }
}
