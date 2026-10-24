import { Controller, Post } from '@nestjs/common';

import { type ReconcileResult, ReconcilerService } from './reconciler.service.js';

@Controller('/v1')
export class ReconcileController {
    constructor(private readonly reconciler: ReconcilerService) { }

    @Post('reconcile')
    reconcile(): Promise<ReconcileResult> {
        return this.reconciler.reconcile();
    }
}
