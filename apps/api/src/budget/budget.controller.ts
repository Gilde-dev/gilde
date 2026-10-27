import { Controller, Get, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { BudgetQuerySchema, type BudgetQuery, type BudgetStatusDto } from './budget.dto.js';
import { BudgetService } from './budget.service.js';

@Controller('/v1/budget')
export class BudgetController {
    constructor(private readonly budget: BudgetService) { }

    /** Global plus optional project day/week status. Read-only; ordinary JWT/API-key auth. */
    @Get()
    status(@Query(new ZodValidationPipe(BudgetQuerySchema)) q: BudgetQuery): Promise<BudgetStatusDto> {
        return this.budget.status(q.projectId);
    }
}
