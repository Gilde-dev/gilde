import { Controller, Delete, Get, HttpCode, Optional, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AuthUser } from '../auth/auth.dto.js';
import { AgentRuntimeService } from '../agent/agent-runtime.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';

import type { McpHandledDto } from './mcp.dto.js';
import { McpService } from './mcp.service.js';

/**
 * Streamable HTTP MCP endpoint, registered only when MCP_ENABLED=true (see McpModule). It is behind the global JwtAuthGuard
 * like every route and is never marked public; the protocol response is written by McpService at the transport boundary.
 */
@Controller('/v1/mcp')
export class McpController {
    constructor(private readonly mcp: McpService, @Optional() private readonly agents?: AgentRuntimeService) { }

    /** MCP_ENABLED is the ceiling; within it the MCP agent's own setting (agents page) switches the server on and off without a restart. */
    @Post()
    @HttpCode(200)
    async handle(@CurrentUser() user: AuthUser | null, @Req() req: Request, @Res() res: Response): Promise<McpHandledDto> {
        if (this.agents && !(await this.agents.isOn('mcp'))) throw new ServiceUnavailableException('The MCP server is switched off');
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
