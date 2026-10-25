import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Feedback } from '../../feedback/feedback.entity.js';
import { Job } from '../../job/job.entity.js';
import { Lesson } from '../../lesson/lesson.entity.js';
import { Project } from '../../project/project.entity.js';
import { Repo } from '../../repo/repo.entity.js';
import { JobRun } from '../../run/run.entity.js';

import { HistoryController } from './history.controller.js';
import { HistoryEntry, HistoryState } from './history.entity.js';
import { HistoryIndexService } from './history-index.service.js';
import { HistorySearchService } from './history-search.service.js';
import { HistorySourceService } from './history-source.service.js';
import { HISTORY_OPTIONS, historyOptions } from './history.types.js';

/**
 * The shared factory history: index, reconciliation and search. Depends only on the (global) MemoryModule and on the
 * entities it reads; it imports neither the co-pilot nor the dispatcher, which both import this module.
 */
@Module({
    imports: [TypeOrmModule.forFeature([HistoryEntry, HistoryState, Job, JobRun, Lesson, Feedback, Repo, Project])],
    controllers: [HistoryController],
    providers: [
        { provide: HISTORY_OPTIONS, useFactory: () => historyOptions() },
        HistorySourceService,
        HistoryIndexService,
        HistorySearchService,
    ],
    exports: [HistorySearchService, HistoryIndexService],
})
export class HistoryModule { }
