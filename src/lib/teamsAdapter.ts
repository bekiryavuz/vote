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
