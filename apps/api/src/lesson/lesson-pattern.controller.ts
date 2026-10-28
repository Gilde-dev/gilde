import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.dto.js';
import { JwtHumanGuard } from '../auth/jwt-human.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { ListLessonPatternsQuerySchema, ProposeSkillSchema, type LessonPatternsResponseDto, type ListLessonPatternsQuery, type ProposeSkillDto, type ProposeSkillResponseDto } from './lesson.dto.js';
import { LessonPatternService } from './lesson-pattern.service.js';
import { LessonSkillProposalService } from './lesson-skill-proposal.service.js';

@Controller('/v1/projects')
export class LessonPatternController {

    constructor(
        private readonly patterns: LessonPatternService,
        private readonly proposals: LessonSkillProposalService,
    ) { }

    @Get(':id/lessons/patterns')
    list(
        @Param('id', ParseUUIDPipe) id: string,
        @Query(new ZodValidationPipe(ListLessonPatternsQuerySchema)) q: ListLessonPatternsQuery,
    ): Promise<LessonPatternsResponseDto> {
        return this.patterns.list(id, q);
    }

    /** Verified humans only: creates one triage job in the skills library repo and moves the pattern's lessons to applying. */
    @Post(':id/lessons/patterns/:patternId/propose-skill')
    @UseGuards(JwtHumanGuard)
    proposeSkill(
        @Param('id', ParseUUIDPipe) id: string,
        @Param('patternId') patternId: string,
        @Body(new ZodValidationPipe(ProposeSkillSchema)) dto: ProposeSkillDto,
        @CurrentUser() user: AuthUser | null,
    ): Promise<ProposeSkillResponseDto> {
        return this.proposals.propose(id, patternId, dto, user);
    }
}
