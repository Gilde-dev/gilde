/** RunService only needs a mapper that returns the row; the real mapper adds fields these tests do not care about. */
export class MapperStub {
    toDTO<T>(entity: T): T {
        return entity;
    }
}
