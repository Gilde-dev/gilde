import { Module } from '@nestjs/common';

import { AgentInstructionsService } from './agent-instructions.service.js';
import { EXECUTION_PORT } from './execution.port.js';
import { RoutineExecutionAdapter } from './routine-execution.adapter.js';

@Module({
    providers: [AgentInstructionsService, { provide: EXECUTION_PORT, useClass: RoutineExecutionAdapter }],
    exports: [EXECUTION_PORT, AgentInstructionsService],
})
export class ExecutionModule { }
