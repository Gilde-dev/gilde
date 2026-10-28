import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** Webhook deliveries already applied, by `x-github-delivery`, so the same delivery arriving twice is handled once. */
@Entity({ name: 'webhook_deliveries' })
export class WebhookDelivery {
    @PrimaryColumn({ name: 'delivery_id' })
    deliveryId: string;

    @CreateDateColumn({ name: 'received_at' })
    receivedAt: Date;
}
