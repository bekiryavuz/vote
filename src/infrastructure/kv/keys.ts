// Every KV key string lives here — one place to read the storage schema.

export const keys = {
    pollMeta: (pollId: string) => `poll:${pollId}:meta`,

    slackTs: (pollId: string) => `poll:${pollId}:slack_ts`,
    slackChannel: (pollId: string) => `poll:${pollId}:slack_channel_id`,
    slackTsIndex: (ts: string) => `poll:slack_ts:${ts}`,

    teamsActivityId: (pollId: string) => `poll:${pollId}:teams_activity_id`,
    teamsRefKey: (pollId: string) => `poll:${pollId}:teams_ref_key`,
    teamsRefInline: (pollId: string) => `poll:${pollId}:teams_ref_inline`,

    vote: (pollId: string, voterKey: string) => `poll:${pollId}:vote:${voterKey}`,
    voteTs: (pollId: string, voterKey: string) => `poll:${pollId}:vote_ts:${voterKey}`,
    votePattern: (pollId: string) => `poll:${pollId}:vote:*`,

    slackUserName: (pollId: string, userId: string) => `poll:${pollId}:slack_user_name:${userId}`,
    slackUserEmail: (pollId: string, userId: string) => `poll:${pollId}:slack_user_email:${userId}`,
    teamsUserName: (pollId: string, userId: string) => `poll:${pollId}:teams_user_name:${userId}`,
    teamsUserEmail: (pollId: string, userId: string) => `poll:${pollId}:teams_user_email:${userId}`,

    convRef: (teamId: string, channelId: string) => `teams:conversation_ref:${teamId}:${channelId}`,
    convRefByChannel: (channelId: string) => `teams:conversation_ref:*:${channelId}`,
    convRefByTeam: (teamId: string) => `teams:conversation_ref:${teamId}:*`
};
