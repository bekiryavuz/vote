// The ONLY place that reads process.env. Everything else takes config / gateways.

export const config = {
    slack: {
        botToken: process.env.SLACK_BOT_TOKEN ?? '',
        channelId: process.env.SLACK_CHANNEL_ID ?? ''
    },
    teams: {
        clientId: process.env.TEAMS_CLIENT_ID ?? '',
        clientSecret: process.env.TEAMS_CLIENT_SECRET ?? '',
        tenantId: process.env.TEAMS_TENANT_ID ?? '',
        appType: process.env.TEAMS_APP_TYPE || 'MultiTenant',
        teamId: process.env.TEAMS_TEAM_ID ?? '',
        channelId: process.env.TEAMS_CHANNEL_ID ?? ''
    },
    kv: {
        url: process.env.KV_REST_API_URL ?? '',
        token: process.env.KV_REST_API_TOKEN ?? ''
    }
} as const;

// Teams integration is optional: when its env is incomplete the app runs Slack-only.
export function teamsBotConfigReady() {
    const { clientId, clientSecret, tenantId, teamId, channelId } = config.teams;
    return Boolean(clientId && clientSecret && tenantId && teamId && channelId);
}
