import { Module } from '@nestjs/common';

import { ProjectModule } from '../project/project.module.js';
import { UsageModule } from '../usage/usage.module.js';

import { BudgetController } from './budget.controller.js';
import { BUDGET_CLOCK, BudgetService } from './budget.service.js';

@Module({
    imports: [ProjectModule, UsageModule],
    controllers: [BudgetController],
    providers: [BudgetService, { provide: BUDGET_CLOCK, useValue: () => new Date() }],
    exports: [BudgetService],
})
export class BudgetModule { }
