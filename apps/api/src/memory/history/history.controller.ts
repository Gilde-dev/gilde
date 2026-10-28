import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';

import { HistoryIndexService } from './history-index.service.js';
import { HistorySearchService } from './history-search.service.js';
import { HistorySearchSchema, type HistoryRunSummary, type HistorySearchInput, type HistorySearchResultDto, type HistoryStatus } from './history.dto.js';

/** Operator access to the shared factory history index. JWT or API key like every other route. */
@Controller('/v1/history')
export class HistoryController {

    constructor(
        private readonly index: HistoryIndexService,
        private readonly search: HistorySearchService,
    ) { }

    @Get('status')
    status(): Promise<HistoryStatus> {
        return this.index.status();
    }

    @Post('search')
    @HttpCode(200)
    searchHistory(@Body(new ZodValidationPipe(HistorySearchSchema)) body: HistorySearchInput): Promise<HistorySearchResultDto> {
        return this.search.search(body);
    }

    /** Runs one bounded part of the reconciliation now (resumes the unfinished pass, or starts one if due). */
    @Post('reconcile')
    @HttpCode(200)
    reconcile(): Promise<HistoryRunSummary> {
        return this.index.reconcile();
    }

    /** Drops every chunk and restarts the backfill from scratch; it continues in bounded steps on the schedule. */
    @Post('rebuild')
    @HttpCode(200)
    rebuild(): Promise<HistoryRunSummary> {
        return this.index.rebuild();
    }
}
