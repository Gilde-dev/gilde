import { Injectable } from '@nestjs/common';

import type { ProjectMcpAuditResponseDto, ProjectMcpServerResponseDto, ProjectMcpToolResponseDto } from './project-mcp.dto.js';
import { ProjectMcpAudit } from './project-mcp-audit.entity.js';
import { ProjectMcpServer } from './project-mcp-server.entity.js';
import { ProjectMcpTool } from './project-mcp-tool.entity.js';

@Injectable()
export class ProjectMcpMapper {

    toDTO(entity: ProjectMcpServer): ProjectMcpServerResponseDto {
        return {
            id: entity.id,
            projectId: entity.projectId,
            name: entity.name,
            url: entity.url,
            hasToken: entity.tokenLast4 !== null,
            tokenLast4: entity.tokenLast4,
            enabled: entity.enabled,
            unattendedEnabled: entity.unattendedEnabled,
            lastTestedAt: entity.lastTestedAt?.toISOString() ?? null,
            lastError: entity.lastError,
            lastErrorAt: entity.lastErrorAt?.toISOString() ?? null,
            callCount: entity.callCount,
            errorCount: entity.errorCount,
            createdAt: entity.createdAt.toISOString(),
            updatedAt: entity.updatedAt.toISOString(),
        };
    }

    toToolDTO(entity: ProjectMcpTool): ProjectMcpToolResponseDto {
        return { name: entity.name, description: entity.description, mode: entity.mode, allowed: entity.allowed };
    }

    toAuditDTO(entity: ProjectMcpAudit): ProjectMcpAuditResponseDto {
        return {
            id: entity.id,
            serverId: entity.serverId,
            serverName: entity.serverName,
            actorId: entity.actorId,
            actorEmail: entity.actorEmail,
            action: entity.action,
            changes: entity.changes,
            createdAt: entity.createdAt.toISOString(),
        };
    }
}
