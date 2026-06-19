import { kvGetRaw, kvListKeys } from '@/lib/kv';

export function pollVoteKey(pollId: string, voterKey: string) {
    return `poll:${pollId}:vote:${voterKey}`;
}

export function pollVoteTsKey(pollId: string, voterKey: string) {
    return `poll:${pollId}:vote_ts:${voterKey}`;
}

export function slackVoterKey(userId: string) {
    return `slack:${userId}`;
}

export function teamsVoterKey(userId: string) {
    return `teams:${userId}`;
}

export function normalizeIdentity(value: string) {
    return value
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

// A resolved vote: `ref` is the platform-prefixed user id (slack:<id> / teams:<id>) used
// for Slack @-mentions; `name` is the human display name used for the Teams card.
export type ResolvedVote = { ref: string; name: string; optionIdx: number };

function asTrimmedString(value: unknown) {
    return typeof value === 'string' ? value.trim() : '';
}

type VoteEntry = { ref: string; name: string; email: string; optionIdx: number; updatedAt: number };

async function readVoteEntries(pollId: string): Promise<VoteEntry[]> {
    const keys = await kvListKeys(`poll:${pollId}:vote:*`);
    const prefix = `poll:${pollId}:vote:`;
    const entries: VoteEntry[] = [];
    for (const key of keys) {
        const raw = await kvGetRaw(key);
        const optionIdx = parseInt(String(raw), 10);
        if (Number.isNaN(optionIdx)) {
            continue;
        }
        const voterKey = key.startsWith(prefix) ? key.slice(prefix.length) : key;
        const tsRaw = await kvGetRaw(pollVoteTsKey(pollId, voterKey));
        const parsedTs = parseInt(String(tsRaw), 10);
        const updatedAt = Number.isNaN(parsedTs) ? 0 : parsedTs;

        let ref = voterKey;
        let name = '';
        let email = '';
        if (voterKey.startsWith('teams:')) {
            const userId = voterKey.slice('teams:'.length);
            ref = `teams:${userId}`;
            name = asTrimmedString(await kvGetRaw(`poll:${pollId}:teams_user_name:${userId}`)) || userId;
            email = asTrimmedString(await kvGetRaw(`poll:${pollId}:teams_user_email:${userId}`));
        } else if (voterKey.startsWith('slack:')) {
            const userId = voterKey.slice('slack:'.length);
            ref = `slack:${userId}`;
            name = asTrimmedString(await kvGetRaw(`poll:${pollId}:slack_user_name:${userId}`)) || userId;
            email = asTrimmedString(await kvGetRaw(`poll:${pollId}:slack_user_email:${userId}`));
        } else {
            ref = voterKey;
            name = voterKey;
        }
        entries.push({ ref, name, email, optionIdx, updatedAt });
    }
    return entries;
}

export async function listVotes(pollId: string): Promise<ResolvedVote[]> {
    const entries = await readVoteEntries(pollId);

    // Dedup the SAME person across Slack + Teams. Two votes are the same person if their
    // email OR their normalized display name matches — email may be missing on one platform
    // (e.g. Slack without users:read.email), so a single "email else name" key fails when one
    // side has email and the other only a name. Union by EITHER signal; latest vote wins.
    const parent = entries.map((_, i) => i);
    const find = (x: number): number => {
        let root = x;
        while (parent[root] !== root) {
            root = parent[root];
        }
        while (parent[x] !== root) {
            const next = parent[x];
            parent[x] = root;
            x = next;
        }
        return root;
    };
    const union = (a: number, b: number) => {
        parent[find(a)] = find(b);
    };

    const byEmail = new Map<string, number>();
    const byName = new Map<string, number>();
    entries.forEach((entry, i) => {
        const emailKey = entry.email ? normalizeIdentity(entry.email) : '';
        const nameKey = entry.name ? normalizeIdentity(entry.name) : '';
        if (emailKey) {
            const prev = byEmail.get(emailKey);
            if (prev !== undefined) {
                union(i, prev);
            } else {
                byEmail.set(emailKey, i);
            }
        }
        if (nameKey) {
            const prev = byName.get(nameKey);
            if (prev === undefined) {
                byName.set(nameKey, i);
            } else {
                // Don't merge two people who share a name but have DIFFERENT known emails.
                const a = entries[i];
                const b = entries[prev];
                const emailsConflict =
                    a.email && b.email && normalizeIdentity(a.email) !== normalizeIdentity(b.email);
                if (!emailsConflict) {
                    union(i, prev);
                }
            }
        }
    });

    const latestByGroup = new Map<number, VoteEntry>();
    entries.forEach((entry, i) => {
        const group = find(i);
        const current = latestByGroup.get(group);
        if (!current || entry.updatedAt >= current.updatedAt) {
            latestByGroup.set(group, entry);
        }
    });

    return Array.from(latestByGroup.values()).map(({ ref, name, optionIdx }) => ({ ref, name, optionIdx }));
}
