import {createWebhookHandler} from '../webhook.mjs';

export const githubWebhook = {
  method: 'post',
  path: '/github-webhook/:service',
  description: 'Restart an allowlisted Swarm service after a signed GitHub master push',
  onRequest: createWebhookHandler()
};
