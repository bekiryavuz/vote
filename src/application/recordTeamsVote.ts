import type { TurnContext } from 'botbuilder';
import { decideVote } from '@/domain/tally';
import { teamsVoterKey } from '@/domain/identity';
import type { PollRepository, TeamsGateway } from '@/application/ports';
import type { SyncPoll } from '@/application/syncPoll';

type SubmitData = { pollId?: string; optionIdx?: number | string };

function asRecord(value: unknown) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function parseJsonString(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

function getRecordValueCaseInsensitive(record: Record<string, unknown>, keys: string[]) {
    const lookup = new Set(keys.map((key) => key.toLowerCase()));
    for (const [key, value] of Object.entries(record)) {
        if (lookup.has(key.toLowerCase())) {
            return value;
        }
    }
    return undefined;
}

function extractFromNode(value: unknown): SubmitData | null {
    const node = asRecord(value);
    if (!node) {
        return null;
    }
    const rawPollId = getRecordValueCaseInsensitive(node, ['pollId', 'poll_id', 'pollid']);
    const rawOptionIdx = getRecordValueCaseInsensitive(node, ['optionIdx', 'option_idx', 'optionid', 'option']);
    const pollId = typeof rawPollId === 'string' ? rawPollId : undefined;
    const optionIdx = typeof rawOptionIdx === 'number' || typeof rawOptionIdx === 'string' ? rawOptionIdx : undefined;
    if (!pollId || optionIdx === undefined) {
        return null;
    }
    return { pollId, optionIdx };
}

// Teams delivers the Action.Submit data in a few shapes (object, nested, JSON string);
// breadth-first search for the {pollId, optionIdx} payload wherever it lives.
export function extractSubmitData(value: unknown): SubmitData | null {
    const queue: unknown[] = [value];
    const seen = new Set<unknown>();
    while (queue.length > 0) {
        const current = queue.shift();
        if (current == null) {
            continue;
        }
        const parsed = parseJsonString(current);
        if (parsed) {
            queue.push(parsed);
            continue;
        }
        if (Array.isArray(current)) {
            for (const item of current) {
                queue.push(item);
            }
            continue;
        }
        if (typeof current !== 'object' || seen.has(current)) {
            continue;
        }
        seen.add(current);
        const match = extractFromNode(current);
        if (match) {
            return match;
        }
        const record = current as Record<string, unknown>;
        for (const value of Object.values(record)) {
            if (value == null) {
                continue;
            }
            if (typeof value === 'object' || Array.isArray(value)) {
                queue.push(value);
                continue;
            }
            const parsedValue = parseJsonString(value);
            if (parsedValue) {
                queue.push(parsedValue);
            }
        }
    }
    return null;
}

export function makeRecordTeamsVote(repo: PollRepository, teams: TeamsGateway, syncPoll: SyncPoll) {
    return async function recordTeamsVote(context: TurnContext, storedRefKey: string | null): Promise<void> {
        const submit = extractSubmitData(context.activity.value);
        if (!submit?.pollId) {
            console.error('Teams vote ignored: submit payload not found', {
                activityType: context.activity.type,
                activityName: context.activity.name,
                valueType: typeof context.activity.value
            });
            return;
        }
        const pollId = submit.pollId;
        const optionIdx = parseInt(String(submit.optionIdx), 10);
        if (!pollId || Number.isNaN(optionIdx)) {
            console.error('Teams vote ignored: invalid poll or option', { pollId, rawOptionIdx: submit.optionIdx });
            return;
        }
        const meta = await repo.getMeta(pollId);
        if (!meta) {
            console.error('Teams vote ignored: poll meta missing', { pollId });
            return;
        }
        if (optionIdx < 0 || optionIdx >= meta.options.length) {
            console.error('Teams vote ignored: option out of range', {
                pollId,
                optionIdx,
                optionsLength: meta.options.length
            });
            return;
        }
        const from = context.activity.from as { aadObjectId?: string; id?: string } | undefined;
        const userId = from?.aadObjectId || from?.id;
        if (!userId) {
            console.error('Teams vote ignored: missing user id', { pollId });
            return;
        }

        // Preserve the send-time channel reference + card activity id (no clobber). Only the
        // channel-level ref key and the voter's identity come from the inbound vote.
        if (storedRefKey) {
            await repo.saveTeamsRefKey(pollId, storedRefKey);
        }
        const userName = typeof context.activity.from?.name === 'string' ? context.activity.from.name.trim() : '';
        const email = await teams.getMemberEmail(context, from?.id || userId);
        await repo.saveTeamsVoter(pollId, userId, userName, email || undefined);

        const voterKey = teamsVoterKey(userId);
        const decision = decideVote(await repo.getVote(pollId, voterKey), optionIdx);
        if (decision.action === 'clear') {
            await repo.clearVote(pollId, voterKey);
        } else {
            await repo.setVote(pollId, voterKey, decision.optionIdx);
        }

        await syncPoll(pollId, meta);
    };
}
