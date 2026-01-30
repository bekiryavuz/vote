import { CloudAdapter, ConfigurationBotFrameworkAuthentication } from 'botbuilder';

const TEAMS_CLIENT_ID = process.env.TEAMS_CLIENT_ID!;
const TEAMS_CLIENT_SECRET = process.env.TEAMS_CLIENT_SECRET!;
const TEAMS_TENANT_ID = process.env.TEAMS_TENANT_ID!;

export const botAppId = TEAMS_CLIENT_ID;

const botAuth = new ConfigurationBotFrameworkAuthentication({
    MicrosoftAppId: TEAMS_CLIENT_ID,
    MicrosoftAppPassword: TEAMS_CLIENT_SECRET,
    MicrosoftAppType: 'MultiTenant',
    MicrosoftAppTenantId: TEAMS_TENANT_ID
});

export const adapter = new CloudAdapter(botAuth);
