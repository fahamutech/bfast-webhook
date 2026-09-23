import {createWebhookHandler} from '../webhook.mjs';

export const githubWebhook = {
  method: 'post',
  path: '/github-webhook/:service',
  description: 'Restart a Swarm service when a signed default-branch push matches its Git clone URL',
  onRequest: createWebhookHandler()
};

import {configuredAdmin} from '../admin.mjs';
const admin = configuredAdmin();
export const adminPage = {method: 'get', path: '/admin', onRequest: admin.page};
export const adminScript = {method: 'get', path: '/admin/app.js', onRequest: admin.script};
export const adminStyle = {method: 'get', path: '/admin/style.css', onRequest: admin.style};
export const adminLogin = {method: 'post', path: '/admin/api/login', onRequest: admin.login};
export const adminSession = {method: 'get', path: '/admin/api/session', onRequest: admin.session};
export const adminLogout = {method: 'post', path: '/admin/api/logout', onRequest: admin.logout};
export const adminServices = {method: 'get', path: '/admin/api/services', onRequest: admin.list};
export const adminService = {method: 'get', path: '/admin/api/services/:service', onRequest: admin.detail};
export const adminUpdate = {method: 'post', path: '/admin/api/services/:service', onRequest: admin.update};

export const adminSecrets = {method: 'get', path: '/admin/api/services/:service/secrets', onRequest: admin.secrets};
export const adminCreateSecret = {method: 'post', path: '/admin/api/services/:service/secrets', onRequest: admin.createSecret};
