import {createWebhookHandler} from '../webhook.mjs';

export const githubWebhook = {
  method: 'post',
  path: '/github-webhook/:service',
  description: 'Restart a Swarm service when a signed default-branch push matches its Git clone URL',
  onRequest: createWebhookHandler()
};
