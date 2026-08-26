export function normalizeReleaseIdentityPart(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function normalizeOptionalReleaseIdentityPart(value: string | null) {
  return value === null ? null : normalizeReleaseIdentityPart(value);
}
