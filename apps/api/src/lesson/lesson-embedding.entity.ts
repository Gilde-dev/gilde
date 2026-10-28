import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** A cached embedding of a lesson text, keyed by the sha256 of the text and the embedding model. Vectors are `simple-json` so SQLite and Postgres both work. */
@Entity({ name: 'lesson_embeddings' })
@Index('IDX_lesson_embeddings_hash_model', ['textHash', 'model'], { unique: true })
export class LessonEmbedding {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'text_hash', type: 'varchar', length: 64 })
    textHash: string;

    @Column({ type: 'varchar', length: 200 })
    model: string;

    @Column({ type: 'simple-json' })
    vector: number[];

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;
}
