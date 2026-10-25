const SECRET_FILE = /^(\.env($|\.)|.*\.(pem|key|p12|pfx|keystore)$|id_(rsa|dsa|ecdsa|ed25519)$)/i;

/** True for .env*, *.pem, *.key and similar files, wherever they are in the tree. */
export const isSecretPath = (path: string): boolean => SECRET_FILE.test(path.split('/').pop() ?? '');

/** A repo-relative path without trailing slashes; throws on absolute paths, `..` segments and backslashes. */
export function cleanRepoPath(path: string): string {
    if (path.includes('\\') || path.includes('\0')) throw new Error('Invalid path');
    if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) throw new Error('Absolute paths are not allowed');
    const segments = path.split('/').filter((s) => s !== '' && s !== '.');
    if (segments.includes('..')) throw new Error('Paths with ".." are not allowed');
    return segments.join('/');
}
