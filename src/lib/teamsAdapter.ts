import { CloudAdapter, ConfigurationBotFrameworkAuthentication } from 'botbuilder';

const TEAMS_CLIENT_ID = process.env.TEAMS_CLIENT_ID!;
const TEAMS_CLIENT_SECRET = process.env.TEAMS_CLIENT_SECRET!;
const TEAMS_TENANT_ID = process.env.TEAMS_TENANT_ID!;
const TEAMS_APP_TYPE = process.env.TEAMS_APP_TYPE || 'MultiTenant';

export const botAppId = TEAMS_CLIENT_ID;

const botAuth = new ConfigurationBotFrameworkAuthentication({
    MicrosoftAppId: TEAMS_CLIENT_ID,
    MicrosoftAppPassword: TEAMS_CLIENT_SECRET,
    MicrosoftAppType: TEAMS_APP_TYPE,
    MicrosoftAppTenantId: TEAMS_TENANT_ID
});

export const adapter = new CloudAdapter(botAuth);

// Without this, CloudAdapter's default onTurnError swallows every error thrown in
// inbound AND proactive (continueConversation) turns — which is why send/update
// failures never surfaced in logs. Surface them explicitly.
adapter.onTurnError = async (context, error) => {
    console.error('Teams adapter onTurnError', {
        activityType: context.activity?.type,
        activityName: context.activity?.name,
        conversationId: context.activity?.conversation?.id,
        serviceUrl: context.activity?.serviceUrl,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error
    });
};
