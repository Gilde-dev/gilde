import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtHumanGuard } from '../auth/jwt-human.guard.js';
import { UserService } from '../user/user.service.js';

import type { JobSyncResultDto, ReconcileResult } from './reconcile.dto.js';
import { ReconcilerService } from './reconciler.service.js';

@Controller('/v1')
export class ReconcileController {
    constructor(
        private readonly reconciler: ReconcilerService,
        private readonly users: UserService,
    ) { }

    @Post('reconcile')
    reconcile(): Promise<ReconcileResult> {
        return this.reconciler.reconcile();
    }

    /** Re-checks one job's PR on GitHub. Verified humans only. */
    @Post('jobs/:id/sync')
    @HttpCode(200)
    @UseGuards(JwtHumanGuard)
    async syncJob(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser | null): Promise<JobSyncResultDto> {
        await this.users.requireVerifiedHuman(user ?? undefined);
        return this.reconciler.syncJob(id);
    }

    /** The reconcile pass for one project's jobs. Verified humans only. */
    @Post('projects/:id/reconcile')
    @HttpCode(200)
    @UseGuards(JwtHumanGuard)
    async reconcileProject(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser | null): Promise<ReconcileResult> {
        await this.users.requireVerifiedHuman(user ?? undefined);
        return this.reconciler.reconcileProject(id);
    }
}
