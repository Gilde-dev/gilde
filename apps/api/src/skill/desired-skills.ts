export interface DesiredManifest {
    stacks: string[];
    skills?: { include?: string[]; exclude?: string[] } | null;
}

export interface DesiredRegistryEntry {
    name: string;
    scope: 'global' | 'stack';
    stacks?: string[];
}

/** Global skills, skills for any of the repo's stacks, and the manifest's includes, minus its excludes. */
export function desiredSkills(manifest: DesiredManifest, registry: DesiredRegistryEntry[]): string[] {
    const names = new Set<string>();
    for (const skill of registry) {
        if (skill.scope === 'global' || (skill.stacks ?? []).some((s) => manifest.stacks.includes(s))) names.add(skill.name);
    }
    for (const name of manifest.skills?.include ?? []) names.add(name);
    for (const name of manifest.skills?.exclude ?? []) names.delete(name);
    return [...names];
}
