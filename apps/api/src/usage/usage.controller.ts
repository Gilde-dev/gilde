import { Controller, Get, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import { UsageQuerySchema, type UsageQuery, type UsageResponseDto } from './usage.dto.js';
import { UsageService } from './usage.service.js';

@Controller('/v1/usage')
export class UsageController {

    constructor(private readonly usageService: UsageService) { }

    @Get()
    get(@Query(new ZodValidationPipe(UsageQuerySchema)) q: UsageQuery): Promise<UsageResponseDto> {
        return this.usageService.summary(q);
    }
}
