// Composition root: build the adapters and wire the use-cases once. Routes import the
// ready-made use-cases from here — no DI container, just three constructions.
import { createPollRepository } from '@/infrastructure/kv/pollRepository';
import { createSlackGateway } from '@/infrastructure/slack/slackGateway';
import { createTeamsGateway } from '@/infrastructure/teams/teamsGateway';
import { makeSyncPoll } from '@/application/syncPoll';
import { makeCreateScheduledPoll, makeCreatePollFromModal } from '@/application/createPoll';
import { makeRecordSlackVote } from '@/application/recordSlackVote';
import { makeRecordTeamsVote } from '@/application/recordTeamsVote';

const repo = createPollRepository();
const slack = createSlackGateway();
const teams = createTeamsGateway(repo);

const syncPoll = makeSyncPoll(repo, slack, teams);

export { repo, slack, syncPoll };
export const createScheduledPoll = makeCreateScheduledPoll(repo, slack, teams);
export const createPollFromModal = makeCreatePollFromModal(repo, slack);
export const recordSlackVote = makeRecordSlackVote(repo, slack, syncPoll);
export const recordTeamsVote = makeRecordTeamsVote(repo, teams, syncPoll);
