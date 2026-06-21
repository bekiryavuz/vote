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
