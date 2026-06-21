import type { ConversationReference, TurnContext } from 'botbuilder';
import type { PollMeta, PollTally } from '@/domain/poll';
import type { VoteEntry } from '@/domain/dedup';

// The three hexagon ports the use-cases depend on. Each hard-won behavior maps to a
// named method here so it cannot silently drift back into a route.

// The ONLY thing that knows KV exists.
export interface PollRepository {
    getMeta(pollId: string): Promise<PollMeta | null>;
    saveMeta(pollId: string, meta: PollMeta): Promise<void>;

    // writes slack_ts + reverse index always, channel only when provided
    setSlackRef(pollId: string, ts: string, channelId: string | null): Promise<void>;
    getSlackTs(pollId: string): Promise<string | null>;
    getSlackChannelId(pollId: string): Promise<string | null>;
    getPollIdBySlackTs(ts: string): Promise<string | null>;

    // teams refs — the send-time activity id / reference are written here ONLY at send time
    saveTeamsActivityId(pollId: string, activityId: string): Promise<void>;
    getTeamsActivityId(pollId: string): Promise<string | null>;
    saveTeamsRefKey(pollId: string, key: string): Promise<void>;
    saveTeamsRefInline(pollId: string, reference: unknown): Promise<void>;
    resolveTeamsReference(pollId: string): Promise<unknown | null>;

    // voter identity + votes
    saveSlackVoter(pollId: string, userId: string, name: string, email?: string): Promise<void>;
    saveTeamsVoter(pollId: string, userId: string, name: string, email?: string): Promise<void>;
    getVote(pollId: string, voterKey: string): Promise<number | null>;
    setVote(pollId: string, voterKey: string, optionIdx: number): Promise<void>;
    clearVote(pollId: string, voterKey: string): Promise<void>;
    readVoteEntries(pollId: string): Promise<VoteEntry[]>;

    // teams conversation-reference store (webhook side); no-overwrite-on-reply
    saveConversationReference(context: TurnContext): Promise<string | null>;
    resolveConversationReference(): Promise<{ key: string; reference: ConversationReference } | null>;
}

// The ONLY thing that knows slack.com exists.
export interface SlackGateway {
    postPoll(channel: string, blocks: unknown[], text: string): Promise<{ ok: boolean; ts?: string; error?: string }>;
    updatePoll(channel: string, ts: string, blocks: unknown[]): Promise<{ ok: boolean; error?: string }>;
    openCreateModal(triggerId: string, channelId: string | null): Promise<{ ok: boolean; error?: string }>;
    getProfile(userId: string): Promise<{ name: string; email: string }>;
}

// The ONLY thing that knows botbuilder / Teams exists.
export interface TeamsGateway {
    isConfigured(): boolean;
    sendPoll(
        pollId: string,
        meta: PollMeta,
        tally: PollTally,
        reference: unknown
    ): Promise<{ activityId: string; reference: unknown } | null>;
    updatePoll(pollId: string, meta: PollMeta, tally: PollTally, reference: unknown, activityId: string): Promise<void>;
    getMemberEmail(context: TurnContext, userId: string): Promise<string>;
    resolveSendReference(): Promise<{ key: string; reference: unknown } | null>;
}
