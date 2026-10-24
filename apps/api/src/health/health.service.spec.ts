import { ServiceUnavailableException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  it('reports up when the database answers', async () => {
    const dataSource = { isInitialized: true, query: vi.fn().mockResolvedValue([]) };
    const service = new HealthService(dataSource as unknown as DataSource);

    await expect(service.getHealth()).resolves.toEqual({
      status: 'up',
      checks: { database: { status: 'up' } },
    });
  });

  it('throws 503 when the database is down', async () => {
    const dataSource = { isInitialized: true, query: vi.fn().mockRejectedValue(new Error('boom')) };
    const service = new HealthService(dataSource as unknown as DataSource);

    await expect(service.getHealth()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
