import { CloudAdapter, ConfigurationBotFrameworkAuthentication } from 'botbuilder';
import { config } from '@/infrastructure/config';

export const botAppId = config.teams.clientId;

const botAuth = new ConfigurationBotFrameworkAuthentication({
    MicrosoftAppId: config.teams.clientId,
    MicrosoftAppPassword: config.teams.clientSecret,
    MicrosoftAppType: config.teams.appType,
    MicrosoftAppTenantId: config.teams.tenantId
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
