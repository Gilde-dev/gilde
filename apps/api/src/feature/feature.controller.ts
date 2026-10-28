import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import {
    CreateFeatureSchema,
    ListFeaturesQuerySchema,
    ReplaceFeatureSchema,
    type CreateFeatureDto,
    type FeatureCancelResponseDto,
    type FeatureDetailResponseDto,
    type FeatureDoneResponseDto,
    type FeatureResponseDto,
    type FeatureStartResponseDto,
    type ListFeaturesQuery,
    type ReplaceFeatureDto,
} from './feature.dto.js';
import { FeatureService } from './feature.service.js';

@Controller('/v1')
export class FeatureController {

    constructor(private readonly featureService: FeatureService) { }

    @Post('projects/:projectId/features')
    create(
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Body(new ZodValidationPipe(CreateFeatureSchema)) dto: CreateFeatureDto,
    ): Promise<FeatureResponseDto> {
        return this.featureService.create(projectId, dto);
    }

    @Get('projects/:projectId/features')
    list(
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Query(new ZodValidationPipe(ListFeaturesQuerySchema)) q: ListFeaturesQuery,
    ): Promise<FeatureResponseDto[]> {
        return this.featureService.list(projectId, q);
    }

    @Get('features/:id')
    getById(@Param('id', ParseUUIDPipe) id: string): Promise<FeatureDetailResponseDto> {
        return this.featureService.getDetail(id);
    }

    @Put('features/:id')
    update(
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(ReplaceFeatureSchema)) dto: ReplaceFeatureDto,
    ): Promise<FeatureResponseDto> {
        return this.featureService.update(id, dto);
    }

    @Post('features/:id/start')
    @HttpCode(200)
    start(@Param('id', ParseUUIDPipe) id: string): Promise<FeatureStartResponseDto> {
        return this.featureService.start(id);
    }

    @Post('features/:id/done')
    @HttpCode(200)
    done(@Param('id', ParseUUIDPipe) id: string): Promise<FeatureDoneResponseDto> {
        return this.featureService.done(id);
    }

    @Post('features/:id/cancel')
    @HttpCode(200)
    cancel(@Param('id', ParseUUIDPipe) id: string): Promise<FeatureCancelResponseDto> {
        return this.featureService.cancel(id);
    }

    @Post('features/:id/reopen')
    @HttpCode(200)
    reopen(@Param('id', ParseUUIDPipe) id: string): Promise<FeatureResponseDto> {
        return this.featureService.reopen(id);
    }

}
