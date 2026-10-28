import { Controller, Delete, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AuthUser } from '../auth/auth.dto.js';
import { CurrentUser } from '../auth/current-user.decorator.js';

import type { McpHandledDto } from './mcp.dto.js';
import { McpService } from './mcp.service.js';

/**
 * Streamable HTTP MCP endpoint, registered only when MCP_ENABLED=true (see McpModule). It is behind the global JwtAuthGuard
 * like every route and is never marked public; the protocol response is written by McpService at the transport boundary.
 */
@Controller('/v1/mcp')
export class McpController {
    constructor(private readonly mcp: McpService) { }

    @Post()
    @HttpCode(200)
    handle(@CurrentUser() user: AuthUser | null, @Req() req: Request, @Res() res: Response): Promise<McpHandledDto> {
        return this.mcp.handle(user ?? undefined, req, res);
    }

    @Get()
    notStreamable(@Res() res: Response): McpHandledDto {
        return this.mcp.methodNotAllowed(res);
    }

    @Delete()
    noSession(@Res() res: Response): McpHandledDto {
        return this.mcp.methodNotAllowed(res);
    }
}
