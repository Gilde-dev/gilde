import type { GitHubPort, GitHubReviewRef } from '../github/github.port.js';

/**
 * The stable identity of a published review: the review row and the head it covers. Written as the first line of the review
 * body (an HTML comment, invisible on GitHub) so a publication whose outcome is uncertain can be found again by lookup.
 */
export function reviewMarker(reviewId: string, headSha: string): string {
    return `<!-- gilde:pr-review:${reviewId}:${headSha} -->`;
}

/**
 * Finds the review we may already have published for this row and head, without running the model again. Null means the
 * complete listing has none; a listing that cannot be completed throws, so absence is never assumed.
 */
export function recoverPublishedReview(github: GitHubPort, fullName: string, prNumber: number, reviewId: string, headSha: string): Promise<GitHubReviewRef | null> {
    return github.findReviewByMarker(fullName, prNumber, reviewMarker(reviewId, headSha), headSha);
}
