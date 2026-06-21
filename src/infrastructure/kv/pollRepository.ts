import { TurnContext } from 'botbuilder';
import type { ConversationReference } from 'botbuilder';
import { config } from '@/infrastructure/config';
import { kvDelete, kvGetJson, kvGetRaw, kvListKeys, kvSet } from '@/infrastructure/kv/client';
import { keys } from '@/infrastructure/kv/keys';
import { normalizeLegacyMeta, PollMeta } from '@/domain/poll';
import type { VoteEntry } from '@/domain/dedup';
import type { PollRepository } from '@/application/ports';

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asTrimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function asOptionIdx(value: unknown): number | null {
    const idx = parseInt(String(value), 10);
    return Number.isNaN(idx) ? null : idx;
}

// Old Slack votes were stored under the bare user id; new ones use the slack:<id> prefix.
// Returns the legacy bare key for a slack voter (Teams was always prefixed).
function legacyVoterKey(voterKey: string): string | null {
    return voterKey.startsWith('slack:') ? voterKey.slice('slack:'.length) : null;
}

async function resolveConversationRefKey(): Promise<string | null> {
    const { teamId, channelId } = config.teams;
    if (teamId && channelId) {
        const exactKey = keys.convRef(teamId, channelId);
        if (await kvGetJson<ConversationReference>(exactKey)) {
            return exactKey;
        }
    }
    if (channelId) {
        const byChannel = await kvListKeys(keys.convRefByChannel(channelId));
        if (byChannel.length > 0) {
            return byChannel[0];
        }
    }
    if (teamId) {
        const byTeam = await kvListKeys(keys.convRefByTeam(teamId));
        if (byTeam.length > 0) {
            return byTeam[0];
        }
    }
    return null;
}

async function resolveConversationReference(): Promise<{ key: string; reference: ConversationReference } | null> {
    const key = await resolveConversationRefKey();
    if (!key) {
        return null;
    }
    const reference = await kvGetJson<ConversationReference>(key);
    if (!reference) {
        return null;
    }
    return { key, reference };
}

export function createPollRepository(): PollRepository {
    return {
        async getMeta(pollId) {
            return normalizeLegacyMeta(await kvGetJson<unknown>(keys.pollMeta(pollId)));
        },

        async saveMeta(pollId, meta: PollMeta) {
            await kvSet(keys.pollMeta(pollId), meta);
        },

        async setSlackRef(pollId, ts, channelId) {
            await kvSet(keys.slackTs(pollId), ts);
            if (channelId) {
                await kvSet(keys.slackChannel(pollId), channelId);
            }
            await kvSet(keys.slackTsIndex(ts), pollId);
        },

        async getSlackTs(pollId) {
            return asString(await kvGetRaw(keys.slackTs(pollId)));
        },

        async getSlackChannelId(pollId) {
            return asString(await kvGetRaw(keys.slackChannel(pollId)));
        },

        async getPollIdBySlackTs(ts) {
            const raw = asString(await kvGetRaw(keys.slackTsIndex(ts)));
            return raw && raw.length > 0 ? raw : null;
        },

        async saveTeamsActivityId(pollId, activityId) {
            await kvSet(keys.teamsActivityId(pollId), activityId);
        },

        async getTeamsActivityId(pollId) {
            return asString(await kvGetRaw(keys.teamsActivityId(pollId)));
        },

        async saveTeamsRefKey(pollId, key) {
            await kvSet(keys.teamsRefKey(pollId), key);
        },

        async saveTeamsRefInline(pollId, reference) {
            await kvSet(keys.teamsRefInline(pollId), reference);
        },

        async resolveTeamsReference(pollId) {
            const inline = await kvGetJson(keys.teamsRefInline(pollId));
            if (inline) {
                return inline;
            }
            const refKey = asString(await kvGetRaw(keys.teamsRefKey(pollId)));
            if (refKey && refKey.length > 0) {
                return kvGetJson(refKey);
            }
            const resolved = await resolveConversationReference();
            return resolved?.reference ?? null;
        },

        async saveSlackVoter(pollId, userId, name, email) {
            if (name) {
                await kvSet(keys.slackUserName(pollId, userId), name);
            }
            if (email) {
                await kvSet(keys.slackUserEmail(pollId, userId), email);
            }
        },

        async saveTeamsVoter(pollId, userId, name, email) {
            if (name) {
                await kvSet(keys.teamsUserName(pollId, userId), name);
            }
            if (email) {
                await kvSet(keys.teamsUserEmail(pollId, userId), email);
            }
        },

        async getVote(pollId, voterKey) {
            const direct = asOptionIdx(await kvGetRaw(keys.vote(pollId, voterKey)));
            if (direct !== null) {
                return direct;
            }
            const legacy = legacyVoterKey(voterKey);
            if (legacy) {
                return asOptionIdx(await kvGetRaw(keys.vote(pollId, legacy)));
            }
            return null;
        },

        async setVote(pollId, voterKey, optionIdx) {
            // Migrate away from any legacy bare-id vote for this voter.
            const legacy = legacyVoterKey(voterKey);
            if (legacy) {
                await kvDelete(keys.vote(pollId, legacy));
                await kvDelete(keys.voteTs(pollId, legacy));
            }
            await kvSet(keys.vote(pollId, voterKey), String(optionIdx));
            await kvSet(keys.voteTs(pollId, voterKey), String(Date.now()));
        },

        async clearVote(pollId, voterKey) {
            const directIdx = asOptionIdx(await kvGetRaw(keys.vote(pollId, voterKey)));
            if (directIdx !== null) {
                await kvDelete(keys.vote(pollId, voterKey));
                await kvDelete(keys.voteTs(pollId, voterKey));
                return;
            }
            const legacy = legacyVoterKey(voterKey);
            if (legacy) {
                await kvDelete(keys.vote(pollId, legacy));
                await kvDelete(keys.voteTs(pollId, legacy));
            }
        },

        async readVoteEntries(pollId) {
            const keyList = await kvListKeys(keys.votePattern(pollId));
            const prefix = `poll:${pollId}:vote:`;
            const entries: VoteEntry[] = [];
            for (const key of keyList) {
                const optionIdx = asOptionIdx(await kvGetRaw(key));
                if (optionIdx === null) {
                    continue;
                }
                const voterKey = key.startsWith(prefix) ? key.slice(prefix.length) : key;
                const updatedAt = asOptionIdx(await kvGetRaw(keys.voteTs(pollId, voterKey))) ?? 0;

                let ref = voterKey;
                let name = '';
                let email = '';
                if (voterKey.startsWith('teams:')) {
                    const userId = voterKey.slice('teams:'.length);
                    ref = `teams:${userId}`;
                    name = asTrimmedString(await kvGetRaw(keys.teamsUserName(pollId, userId))) || userId;
                    email = asTrimmedString(await kvGetRaw(keys.teamsUserEmail(pollId, userId)));
                } else if (voterKey.startsWith('slack:')) {
                    const userId = voterKey.slice('slack:'.length);
                    ref = `slack:${userId}`;
                    name = asTrimmedString(await kvGetRaw(keys.slackUserName(pollId, userId))) || userId;
                    email = asTrimmedString(await kvGetRaw(keys.slackUserEmail(pollId, userId)));
                } else {
                    ref = voterKey;
                    name = voterKey;
                }
                entries.push({ ref, name, email, optionIdx, updatedAt });
            }
            return entries;
        },

        async saveConversationReference(context) {
            const channelData = context.activity.channelData as
                | { team?: { id?: string }; channel?: { id?: string } }
                | undefined;
            const teamId = channelData?.team?.id;
            const channelId = channelData?.channel?.id;
            if (!teamId || !channelId) {
                return null;
            }
            const reference = TurnContext.getConversationReference(context.activity);
            const key = keys.convRef(teamId, channelId);
            const existing = await kvGetJson<ConversationReference>(key);
            // Do not overwrite a channel-level reference with a thread-reply reference.
            if (context.activity.replyToId && existing) {
                return key;
            }
            await kvSet(key, reference);
            return key;
        },

        async resolveConversationReference() {
            return resolveConversationReference();
        }
    };
}
