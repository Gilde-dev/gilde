import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
    FailNotificationSchema,
    ListNotificationsQuerySchema,
    type FailNotificationDto,
    type ListNotificationsQuery,
    type NotificationResponseDto,
} from './notification.dto.js';
import { NotificationService } from './notification.service.js';

@Controller('/v1/notifications')
export class NotificationController {

    constructor(private readonly notificationService: NotificationService) { }

    @Get()
    listDue(@Query(new ZodValidationPipe(ListNotificationsQuerySchema)) q: ListNotificationsQuery): Promise<NotificationResponseDto[]> {
        return this.notificationService.listDue(q);
    }

    @Post(':id/delivered')
    @HttpCode(200)
    delivered(@Param('id', ParseUUIDPipe) id: string): Promise<NotificationResponseDto> {
        return this.notificationService.markDelivered(id);
    }

    @Post(':id/failed')
    @HttpCode(200)
    failed(
        @Param('id', ParseUUIDPipe) id: string,
        @Body(new ZodValidationPipe(FailNotificationSchema)) dto: FailNotificationDto,
    ): Promise<NotificationResponseDto> {
        return this.notificationService.markFailed(id, dto);
    }

}
