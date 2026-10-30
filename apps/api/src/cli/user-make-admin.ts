import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { databaseConfig } from '../database.config.js';
import { UserModule } from '../user/user.module.js';
import { UserService } from '../user/user.service.js';

import { parseMakeAdminArgs } from './args.js';

@Module({
    imports: [TypeOrmModule.forRoot(databaseConfig()), UserModule],
})
class CliModule { }

async function main() {
    const { email } = parseMakeAdminArgs(process.argv.slice(2));
    const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });
    try {
        const user = await app.get(UserService).makeAdmin(email);
        console.log(`${user.email} (${user.id}) is an admin`);
    } finally {
        await app.close();
    }
}

main().catch((e: unknown) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
