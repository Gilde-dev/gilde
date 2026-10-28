import { Controller, Get } from "@nestjs/common";
import { Public } from "../common/public.decorator.js";
import type { HealthResponseDto } from "./health.dto.js";
import { HealthService } from "./health.service.js";

@Public()
@Controller('/health')
export class HealthController {

    constructor(
        private readonly healthService: HealthService
    ) { }

    @Get()
    async health(): Promise<HealthResponseDto> {
        return this.healthService.getHealth();
    }

}