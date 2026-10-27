import { Module } from '@nestjs/common';

import { NotificationModule } from '../notification/notification.module.js';
import { ProjectModule } from '../project/project.module.js';
import { UsageModule } from '../usage/usage.module.js';

import { BudgetAlertService } from './budget-alert.service.js';
import { BudgetController } from './budget.controller.js';
import { BUDGET_CLOCK, BudgetService } from './budget.service.js';

@Module({
    imports: [ProjectModule, UsageModule, NotificationModule],
    controllers: [BudgetController],
    providers: [BudgetService, BudgetAlertService, { provide: BUDGET_CLOCK, useValue: () => new Date() }],
    exports: [BudgetService, BudgetAlertService],
})
export class BudgetModule { }
