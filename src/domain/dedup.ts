import { normalizeIdentity } from '@/domain/identity';

// A raw vote read from storage, before cross-platform de-duplication.
export type VoteEntry = {
    ref: string;
    name: string;
    email: string;
    optionIdx: number;
    updatedAt: number;
};

// `ref` is the platform-prefixed user id (slack:<id> / teams:<id>) used for Slack
// @-mentions; `name` is the human display name used on the Teams card.
export type ResolvedVote = {
    ref: string;
    name: string;
    optionIdx: number;
};

// Dedup the SAME person across Slack + Teams. Two votes are the same person if their
// email OR their normalized display name matches — email may be missing on one platform
// (e.g. Slack without users:read.email), so a single "email else name" key fails when one
// side has email and the other only a name. Union by EITHER signal; latest vote wins.
export function resolveVotes(entries: VoteEntry[]): ResolvedVote[] {
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
