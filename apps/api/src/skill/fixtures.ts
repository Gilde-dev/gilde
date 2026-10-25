/** A small library as a map of path → content, usable for both folder and repo libraries. */
export const LIBRARY_FILES: Record<string, string> = {
    'registry.yaml': [
        'skills:',
        '  - name: alpha',
        '    scope: global',
        '  - name: beta',
        '    scope: stack',
        '    stacks: [nestjs]',
        '',
    ].join('\n'),
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: Alpha skill\n---\nBody A\n',
    'skills/beta/SKILL.md': '---\nname: beta\ndescription: Beta skill\n---\nBody B\n',
    'skills/beta/scripts/run.sh': 'echo hi\n',
};
