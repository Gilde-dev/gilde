import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { databaseConfig } from '../database.config.js';
import { LessonModule } from '../lesson/lesson.module.js';
import { LessonService } from '../lesson/lesson.service.js';

import { parseRejectRetroCandidatesArgs } from './args.js';

@Module({
    imports: [TypeOrmModule.forRoot(databaseConfig()), LessonModule],
})
class CliModule { }

async function main() {
    const { dryRun } = parseRejectRetroCandidatesArgs(process.argv.slice(2));
    const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });
    try {
        const ids = await app.get(LessonService).rejectRetroCandidates(dryRun);
        if (dryRun) {
            console.log(`Dry run: ${ids.length} retro-only candidate lesson(s) would be rejected`);
            for (const id of ids) console.log(`  ${id}`);
        } else {
            console.log(`Rejected ${ids.length} retro-only candidate lesson(s)`);
        }
    } finally {
        await app.close();
    }
}

main().catch((e: unknown) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
