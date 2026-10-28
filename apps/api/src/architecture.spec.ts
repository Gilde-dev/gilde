import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * Enforces the controller conventions of AGENTS.md: updates use PUT (no @Patch), controllers depend on services only
 * (no entities, repositories, DataSource or EntityManager) and return DTO types from *.dto.ts (or void for 204).
 */

export interface Violation {
    file: string;
    line: number;
    rule: 'no-patch' | 'no-persistence' | 'no-entity-import' | 'dto-return';
    message: string;
}

/** Returns the text of the module a relative import specifier points at, or undefined when it is not available. */
export type ModuleReader = (specifier: string) => string | undefined;

const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All']);
const PERSISTENCE_NAMES = ['InjectRepository', 'Repository', 'DataSource', 'EntityManager'];

export function checkController(file: string, text: string, readModule: ModuleReader): Violation[] {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const violations: Violation[] = [];
    const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const add = (node: ts.Node, rule: Violation['rule'], message: string) => violations.push({ file, line: lineOf(node), rule, message });

    // Local names bound by imports: local -> { module, imported }; namespace imports: local -> module.
    const named = new Map<string, { module: string; imported: string }>();
    const namespaces = new Map<string, string>();
    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const module = stmt.moduleSpecifier.text;
        const bindings = stmt.importClause?.namedBindings;
        if (module.endsWith('.entity.js')) add(stmt, 'no-entity-import', `Controllers must not import entities (${module})`);
        if (!bindings) continue;
        if (ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, module);
        else for (const el of bindings.elements) named.set(el.name.text, { module, imported: (el.propertyName ?? el.name).text });
    }

    const patchNames = new Set<string>();
    for (const [local, b] of named) if (b.module === '@nestjs/common' && b.imported === 'Patch') patchNames.add(local);
    const persistenceNames = new Set<string>(PERSISTENCE_NAMES);
    for (const [local, b] of named) if (PERSISTENCE_NAMES.includes(b.imported)) persistenceNames.add(local);
    const nestNamespaces = new Set([...namespaces].filter(([, m]) => m === '@nestjs/common').map(([n]) => n));

    const resolveNamed = (name: string) => named.get(name);
    const decoratorName = (d: ts.Decorator): string | undefined => {
        const expr = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
        if (ts.isIdentifier(expr)) {
            const b = resolveNamed(expr.text);
            return b?.module === '@nestjs/common' ? b.imported : undefined;
        }
        if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && nestNamespaces.has(expr.expression.text)) return expr.name.text;
        return undefined;
    };

    const visit = (node: ts.Node): void => {
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
            && node.argument.literal.text.endsWith('.entity.js')) {
            add(node, 'no-entity-import', `Controllers must not import entities (${node.argument.literal.text})`);
        }
        if ((ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.endsWith('.entity.js')) {
            add(node, 'no-entity-import', `Controllers must not import entities (${node.moduleSpecifier.text})`);
        }
        if (ts.isIdentifier(node)) {
            if (patchNames.has(node.text)) add(node, 'no-patch', 'Updates use PUT; there are no PATCH routes (@Patch)');
            else if (persistenceNames.has(node.text)) add(node, 'no-persistence', `Controllers depend on services only; found ${node.text}`);
        }
        if (ts.isPropertyAccessExpression(node) && node.name.text === 'Patch' && ts.isIdentifier(node.expression) && nestNamespaces.has(node.expression.text)) {
            add(node, 'no-patch', 'Updates use PUT; there are no PATCH routes (@Patch)');
        }
        if (ts.isMethodDeclaration(node)) checkRoute(node);
        ts.forEachChild(node, visit);
    };

    const isDtoType = (name: string, seen = new Set<string>()): string | null => {
        const b = resolveNamed(name);
        if (!b) return `${name} is not imported from a *.dto.ts file`;
        if (!b.module.endsWith('.dto.js')) return `${name} comes from ${b.module}, not a *.dto.ts file`;
        const source = readModule(b.module);
        if (source === undefined) return `${b.module} (for ${name}) could not be read`;
        return inferredIn(source, b.imported, seen);
    };

    const checkRoute = (method: ts.MethodDeclaration): void => {
        const decorators = (ts.getDecorators(method) ?? []).map((d) => ({ d, name: decoratorName(d) }));
        if (!decorators.some((d) => d.name && HTTP_DECORATORS.has(d.name))) return;
        const no204 = decorators.some((d) => d.name === 'HttpCode' && /\b204\b/.test(d.d.getText(sf)));
        if (!method.type) {
            add(method.name, 'dto-return', `Route ${method.name.getText(sf)} needs an explicit return type (a DTO from *.dto.ts)`);
            return;
        }
        const problem = checkReturnType(method.type, no204);
        if (problem) add(method.type, 'dto-return', `Route ${method.name.getText(sf)}: ${problem}`);
    };

    const checkReturnType = (type: ts.TypeNode, allowVoid: boolean): string | null => {
        if (ts.isParenthesizedTypeNode(type)) return checkReturnType(type.type, allowVoid);
        if (type.kind === ts.SyntaxKind.VoidKeyword) return allowVoid ? null : 'void is only allowed for @HttpCode(204) routes';
        if (ts.isArrayTypeNode(type)) return checkReturnType(type.elementType, false);
        if (ts.isUnionTypeNode(type)) {
            for (const t of type.types) {
                const p = checkReturnType(t, false);
                if (p) return p;
            }
            return null;
        }
        if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
            const name = type.typeName.text;
            if ((name === 'Promise' || name === 'Array') && type.typeArguments?.length === 1) {
                return checkReturnType(type.typeArguments[0], name === 'Promise' && allowVoid);
            }
            return isDtoType(name);
        }
        return `return type ${type.getText(sf)} is not a DTO type from *.dto.ts`;
    };

    ts.forEachChild(sf, visit);
    // One finding per rule and line (an aliased import names the same thing twice).
    const unique = violations.filter((v, i) => violations.findIndex((o) => o.line === v.line && o.rule === v.rule) === i);
    return unique.sort((a, b) => a.line - b.line);
}

/** `export type Name = z.infer<typeof Schema>` (directly, or an alias of another such type in the same file). */
function inferredIn(source: string, name: string, seen: Set<string>): string | null {
    if (seen.has(name)) return `${name} is a circular alias`;
    seen.add(name);
    const sf = ts.createSourceFile('dto.ts', source, ts.ScriptTarget.Latest, true);
    for (const stmt of sf.statements) {
        if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) return `${name} is an interface; define it as z.infer<typeof Schema>`;
        if (!ts.isTypeAliasDeclaration(stmt) || stmt.name.text !== name) continue;
        const t = stmt.type;
        if (ts.isTypeReferenceNode(t)) {
            const tn = t.typeName;
            const isInfer = (ts.isQualifiedName(tn) && tn.right.text === 'infer') || (ts.isIdentifier(tn) && tn.text === 'infer');
            if (isInfer) return null;
            if (ts.isIdentifier(tn) && !t.typeArguments) return inferredIn(source, tn.text, seen);
        }
        return `${name} must be z.infer<typeof Schema>`;
    }
    return `${name} is not declared as a z.infer type in its *.dto.ts`;
}

function controllerFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : controllerFiles(path);
        return entry.endsWith('.controller.ts') ? [path] : [];
    });
}

const SRC = dirname(fileURLToPath(import.meta.url));

function checkOnDisk(path: string): Violation[] {
    const reader: ModuleReader = (specifier) => {
        try {
            return readFileSync(resolve(dirname(path), specifier.replace(/\.js$/, '.ts')), 'utf8');
        } catch {
            return undefined;
        }
    };
    return checkController(path.slice(SRC.length + 1), readFileSync(path, 'utf8'), reader);
}

describe('controller conventions (production tree)', () => {
    const files = controllerFiles(SRC);

    it('finds the controllers', () => {
        expect(files.length).toBeGreaterThan(15);
    });

    it('has no violations', () => {
        const violations = files.flatMap(checkOnDisk).map((v) => `${v.file}:${v.line} [${v.rule}] ${v.message}`);
        expect(violations).toEqual([]);
    });
});

describe('spec domain (production tree)', () => {
    const controller = readFileSync(join(SRC, 'spec', 'spec.controller.ts'), 'utf8');
    const dto = readFileSync(join(SRC, 'spec', 'spec.dto.ts'), 'utf8');

    it('is covered by the controller conventions', () => {
        expect(controllerFiles(SRC).map((f) => f.slice(SRC.length + 1))).toContain(join('spec', 'spec.controller.ts'));
        expect(checkOnDisk(join(SRC, 'spec', 'spec.controller.ts'))).toEqual([]);
    });

    it('keeps approval behind the verified-human guard and the other routes reachable by any authenticated user', () => {
        const approve = /@Post\('specs\/:id\/approve'\)[\s\S]*?approve\(/.exec(controller)?.[0] ?? '';
        expect(approve).toContain('@UseGuards(JwtHumanGuard)');
        expect(controller.match(/@UseGuards\(/g)).toHaveLength(1);
        expect(controller).not.toContain('@Public(');
    });

    it('takes the actor from the request context, never from a body schema', () => {
        const schemas = dto.match(/export const (?:Create|Save|Approve)\w+Schema = z\.(\w+)\(/g) ?? [];
        expect(schemas).toHaveLength(3);
        expect(schemas.every((s) => s.endsWith('z.strictObject('))).toBe(true);
        expect(dto.slice(0, dto.indexOf('export type CreateSpecDto'))).not.toMatch(/\b(?:actor|createdBy|updatedBy|approvedBy)\w*\s*:\s*z\./);
        expect(controller).not.toContain('@Req(');
    });
});

describe('checkController', () => {
    const dtos: Record<string, string> = {
        './thing.dto.js': `
            import { z } from 'zod';
            export const ThingSchema = z.object({ id: z.string() });
            export type ThingDto = z.infer<typeof ThingSchema>;
            export type ThingAlias = ThingDto;
            export interface BadDto { id: string }
            export type Plain = { id: string };
        `,
    };
    const reader: ModuleReader = (s) => dtos[s];
    const run = (text: string) => checkController('fixture.controller.ts', text, reader);
    const ok = `
        import { Controller, Get, Put, HttpCode, Delete } from '@nestjs/common';
        import { ThingService } from './thing.service.js';
        import type { ThingDto } from './thing.dto.js';
        // @Patch, Repository<Thing> and thing.entity.js in a comment are fine
        const text = "@Patch Repository<Thing> DataSource EntityManager './thing.entity.js'";
        @Controller('/v1')
        export class ThingController {
            constructor(private readonly things: ThingService) { }
            @Get('a') one(): Promise<ThingDto> { return this.things.one(); }
            @Get('b') many(): Promise<ThingDto[]> { return this.things.many(); }
            @Get('c') sync(): ThingDto { return this.things.sync(); }
            @Put('d') replace(): Promise<ThingDto> { return this.things.replace(); }
            @Delete('e') @HttpCode(204) remove(): Promise<void> { return this.things.remove(); }
            private helper(): string { return ''; }
        }
    `;

    it('accepts a service-only controller with DTO returns, arrays and 204', () => {
        expect(run(ok)).toEqual([]);
    });

    it('accepts a DTO that aliases another z.infer type', () => {
        expect(run(`
            import { Controller, Get } from '@nestjs/common';
            import type { ThingAlias } from './thing.dto.js';
            @Controller() export class C { @Get() a(): Promise<ThingAlias> { return null!; } }
        `)).toEqual([]);
    });

    it('flags @Patch with its line', () => {
        const v = run(`import { Controller, Patch } from '@nestjs/common';
@Controller()
export class C {
    @Patch('x') a(): Promise<void> { return null!; }
}`);
        expect(v.filter((x) => x.rule === 'no-patch').map((x) => x.line)).toEqual([1, 4]);
    });

    it('flags an aliased multiline @Patch import and namespace use', () => {
        const aliased = run(`import {
    Controller,
    Patch as Change,
} from '@nestjs/common';
@Controller()
export class C {
    @Change('x') a(): Promise<void> { return null!; }
}`);
        expect(aliased.filter((x) => x.rule === 'no-patch').map((x) => x.line)).toEqual([3, 7]);
        const ns = run(`import * as nest from '@nestjs/common';
@nest.Controller()
export class C {
    @nest.Patch('x') a(): Promise<void> { return null!; }
}`);
        expect(ns.filter((x) => x.rule === 'no-patch').map((x) => x.line)).toEqual([4]);
    });

    it.each([
        ['InjectRepository', `import { InjectRepository } from '@nestjs/typeorm';\nexport class C { constructor(@InjectRepository(X) r: unknown) { } }`, [1, 2]],
        ['Repository<', `import { Repository } from 'typeorm';\nexport class C { constructor(r: Repository<X>) { } }`, [1, 2]],
        ['aliased Repository', `import {\n    Repository as Repo,\n} from 'typeorm';\nexport class C { constructor(r: Repo<X>) { } }`, [2, 4]],
        ['DataSource', `import { DataSource } from 'typeorm';\nexport class C { constructor(d: DataSource) { } }`, [1, 2]],
        ['EntityManager', `import { EntityManager } from 'typeorm';\nexport class C { constructor(m: EntityManager) { } }`, [1, 2]],
    ])('flags %s', (_name, text, lines) => {
        const v = run(text);
        expect(v.map((x) => x.rule)).toEqual(lines.map(() => 'no-persistence'));
        expect(v.map((x) => x.line)).toEqual(lines);
    });

    it('flags entity imports, also type-only and multiline', () => {
        expect(run(`import { Job } from '../job/job.entity.js';`).map((x) => [x.rule, x.line])).toEqual([['no-entity-import', 1]]);
        expect(run(`\nimport type { Job } from '../job/job.entity.js';`).map((x) => [x.rule, x.line])).toEqual([['no-entity-import', 2]]);
        expect(run(`import {\n    Job,\n    type Repo,\n} from '../x.entity.js';`).map((x) => [x.rule, x.line])).toEqual([['no-entity-import', 1]]);
        expect(run(`export type J = import('../job/job.entity.js').Job;`).map((x) => x.rule)).toEqual(['no-entity-import']);
    });

    describe('return types', () => {
        const route = (ret: string, imports = `import type { ThingDto, BadDto, Plain } from './thing.dto.js';`, extra = '') => run(`
import { Controller, Get, Delete, HttpCode } from '@nestjs/common';
${imports}
import type { ThingEntityLike } from './thing.service.js';
@Controller()
export class C {
    ${extra}@Get() a()${ret} { return null!; }
}`);

        it('flags a missing annotation', () => {
            const v = route('');
            expect(v).toHaveLength(1);
            expect(v[0]).toMatchObject({ rule: 'dto-return', line: 7 });
        });

        it('flags service-internal types, inline object types and interfaces/aliases that are not z.infer', () => {
            expect(route(': Promise<ThingEntityLike>')[0].message).toContain('not a *.dto.ts file');
            expect(route(': Promise<{ result: string }>')[0].message).toContain('not a DTO type');
            expect(route(': Promise<BadDto>')[0].message).toContain('interface');
            expect(route(': Promise<Plain>')[0].message).toContain('z.infer');
            expect(route(': Promise<ThingDto | ThingEntityLike>')[0].message).toContain('not a *.dto.ts file');
            expect(route(': Promise<ThingEntityLike[]>')[0].rule).toBe('dto-return');
        });

        it('allows void only for @HttpCode(204)', () => {
            expect(route(': Promise<void>')[0].message).toContain('204');
            expect(route(': Promise<void>', undefined, '@HttpCode(204) ')).toEqual([]);
        });

        it('reports the line of the return type', () => {
            expect(route(': Promise<ThingEntityLike>')[0].line).toBe(7);
        });
    });
});
