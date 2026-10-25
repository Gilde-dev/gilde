import { Injectable } from '@nestjs/common';

import type { ApiKeyResponseDto } from './api-key.dto.js';
import { ApiKey } from './api-key.entity.js';

@Injectable()
export class ApiKeyMapper {

    toDTO(entity: ApiKey): ApiKeyResponseDto {
        return {
            id: entity.id,
            name: entity.name,
            prefix: entity.prefix,
            createdAt: entity.createdAt.toISOString(),
            lastUsedAt: entity.lastUsedAt?.toISOString() ?? null,
            expiresAt: entity.expiresAt?.toISOString() ?? null,
        };
    }
}
