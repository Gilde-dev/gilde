import { Controller, Get } from "@nestjs/common";
import { Public } from "../common/public.decorator.js";
import { HealthService } from "./health.service.js";

@Public()
@Controller('/health')
export class HealthController {

    constructor(
        private readonly healthService: HealthService
    ) { }

    @Get()
    async health() {
        return this.healthService.getHealth();
    }

}