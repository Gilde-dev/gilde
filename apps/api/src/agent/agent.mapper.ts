import { Injectable } from '@nestjs/common';

import { hasModel, isBotAgent } from './agent-ids.js';
import { SETTING_FIELDS } from './agent-settings.js';
import type { EffectiveAgent } from './agent-runtime.service.js';
import type { AgentDto } from './agent.dto.js';

@Injectable()
export class AgentMapper {
    /** Settings without secrets: the effective state never holds any, and the parsed config stays inside the service. */
    toDTO(agent: EffectiveAgent): AgentDto {
        return {
            id: agent.id,
            label: agent.label,
            status: agent.status,
            reason: agent.reason,
            enabled: agent.enabled,
            model: agent.model,
            effectiveModel: agent.effectiveModel,
            hasModel: hasModel(agent.id),
            hasBotUser: isBotAgent(agent.id),
            botUserId: agent.botUserId,
            botUser: agent.botUser,
            settings: agent.settings,
            fields: SETTING_FIELDS[agent.id].map(({ key, label, kind, min, max, default: def }) => ({ key, label, kind, min, max, default: def })),
            updatedAt: (agent.updatedAt ?? new Date(0)).toISOString(),
        };
    }
}
