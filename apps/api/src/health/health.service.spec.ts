import { ServiceUnavailableException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  it('reports up when the database answers', async () => {
    const dataSource = { isInitialized: true, query: async () => [] } as unknown as DataSource;

    await expect(new HealthService(dataSource).getHealth()).resolves.toEqual({
      status: 'up',
      checks: { database: { status: 'up' } },
    });
  });

  it('throws 503 when the data source is not initialized', async () => {
    const dataSource = { isInitialized: false } as unknown as DataSource;

    await expect(new HealthService(dataSource).getHealth()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
