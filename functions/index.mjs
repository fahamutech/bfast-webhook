import {createWebhookHandler} from '../webhook.mjs';

export const githubWebhook = {
  method: 'post',
  path: '/github-webhook/:service',
  description: 'Restart an allowlisted Swarm service after a signed push to its GitHub default branch',
  onRequest: createWebhookHandler()
};
