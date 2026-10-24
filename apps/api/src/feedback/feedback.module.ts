import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Feedback } from './feedback.entity.js';
import { FeedbackController } from './feedback.controller.js';
import { FeedbackMapper } from './feedback.mapper.js';
import { FeedbackService } from './feedback.service.js';

@Module({
    imports: [TypeOrmModule.forFeature([Feedback])],
    controllers: [FeedbackController],
    providers: [FeedbackMapper, FeedbackService],
    exports: [FeedbackService],
})
export class FeedbackModule { }
