// Pure identity helpers shared by the vote/dedup logic. No I/O.

export function normalizeIdentity(value: string) {
    return value
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function slackVoterKey(userId: string) {
    return `slack:${userId}`;
}

export function teamsVoterKey(userId: string) {
    return `teams:${userId}`;
}

// Pairwise "is this the same person?" — the building block of cross-platform identity.
// If both sides have an email, the email decides (so two different people who share a
// display name but have different emails are NOT merged). Otherwise fall back to the
// normalized display name. Mirrors the union rule used by resolveVotes.
export function samePerson(
    a: { name?: string; email?: string },
    b: { name?: string; email?: string }
): boolean {
    const aEmail = a.email ? normalizeIdentity(a.email) : '';
    const bEmail = b.email ? normalizeIdentity(b.email) : '';
    if (aEmail && bEmail) {
        return aEmail === bEmail;
    }
    const aName = a.name ? normalizeIdentity(a.name) : '';
    const bName = b.name ? normalizeIdentity(b.name) : '';
    return Boolean(aName) && aName === bName;
}
