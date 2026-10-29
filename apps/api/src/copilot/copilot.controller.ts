import { Controller, Get, Inject, Optional, Param, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import type { CopilotConfig } from './copilot.config.js';
import { AgentRuntimeService, type EffectiveAgent } from '../agent/agent-runtime.service.js';
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
        @Optional() private readonly activity?: ScoutActivityService,
        @Optional() private readonly threads?: CopilotThreadsService,
        @Optional() private readonly agents?: AgentRuntimeService,
        @Optional() @Inject(SCOUT_SETUP) private readonly scout: ScoutSetup | null = null,
        @Optional() @Inject(REFINE_SETUP) private readonly refine: RefineSetup | null = null,
    ) { }

    /** What the agents are now, from their settings in the database (`/v1/agents` has the full picture). */
    @Get('status')
    async status(): Promise<CopilotStatusDto> {
        const live = this.agents;
        const on = (a: EffectiveAgent) => a.status === 'on';
        // A fixed setup or config (tests) is reported as it is; the live ones defer to the settings.
        const gilde = !live || (this.config.enabled && !this.config.resolve) ? null : await live.effective('gilde');
        const scout = !live || (this.scout && !this.scout.resolve) ? null : await live.effective('verkenner');
        const refine = !live || (this.refine && !this.refine.resolve) ? null : await live.effective('verfijner');
        return {
            enabled: gilde ? on(gilde) : this.config.enabled,
            model: gilde ? (on(gilde) ? gilde.effectiveModel : null) : this.config.model,
            scout: scout
                ? { enabled: on(scout), model: on(scout) ? scout.effectiveModel : null, disabledReason: scout.status === 'misconfigured' || scout.status === 'disabled_by_env' ? scout.reason : null }
                : { enabled: this.scout !== null, model: this.scout?.config.model ?? null, disabledReason: null },
            refine: refine
                ? { enabled: on(refine), model: on(refine) ? refine.effectiveModel : null }
                : { enabled: this.refine !== null, model: this.refine?.config.model ?? null },
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
