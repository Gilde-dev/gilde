import { Module } from '@nestjs/common';

import { EXECUTION_PORT } from './execution.port.js';
import { RoutineExecutionAdapter } from './routine-execution.adapter.js';

@Module({
    providers: [{ provide: EXECUTION_PORT, useClass: RoutineExecutionAdapter }],
    exports: [EXECUTION_PORT],
})
export class ExecutionModule { }
