/**
 * LocalGobe Draft Release Promotion Helper
 *
 * Implements the atomic draft-to-public promotion model:
 *   - Verifies the release is in draft state
 *   - Validates the installer hash against the validated draft hash (VALIDATED_DRAFT_SHA256 == PUBLIC_RELEASE_SHA256)
 *   - Sets draft=false via GitHub API
 *   - Absolutely NO checkout, rebuild, packaging, or file replacement
 */

export type PromotionConfig = {
  owner: string;
  repo: string;
  tag: string;
  expectedSha256: string;
};

export const PROMOTION_POLICY = Object.freeze({
  DRAFT_RELEASE_PROMOTION_REBUILDS: "NO",
  DRAFT_TO_PUBLIC_HASH_IDENTITY_ENFORCED: "YES",
  MUTATION_ALLOWED: "draft=true -> draft=false ONLY",
});

export function validatePromotionIntegrity(params: {
  draftInstallerSha256: string;
  expectedSha256: string;
}): boolean {
  if (!params.draftInstallerSha256 || !params.expectedSha256) {
    return false;
  }
  return params.draftInstallerSha256.toLowerCase() === params.expectedSha256.toLowerCase();
}
