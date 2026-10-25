import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ListRevisionsQuerySchema, type ListRevisionsQuery, type RevisionResponseDto } from './revision.dto.js';
import { RevisionService } from './revision.service.js';

@Controller('/v1')
export class RevisionController {

    constructor(private readonly revisionService: RevisionService) { }

    @Get('jobs/:id/revisions')
    listForJob(@Param('id', ParseUUIDPipe) id: string): Promise<RevisionResponseDto[]> {
        return this.revisionService.listForJob(id);
    }

    @Get('revisions')
    list(@Query(new ZodValidationPipe(ListRevisionsQuerySchema)) q: ListRevisionsQuery): Promise<RevisionResponseDto[]> {
        return this.revisionService.list(q);
    }

    @Post('revisions/:id/accept')
    @HttpCode(200)
    accept(@Param('id', ParseUUIDPipe) id: string): Promise<RevisionResponseDto> {
        return this.revisionService.accept(id);
    }

    @Post('revisions/:id/reject')
    @HttpCode(200)
    reject(@Param('id', ParseUUIDPipe) id: string): Promise<RevisionResponseDto> {
        return this.revisionService.reject(id);
    }

}
