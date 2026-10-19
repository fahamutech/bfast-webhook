import {createWebhookHandler, createDeliveryLog} from '../webhook.mjs';

// One delivery history shared by the GitHub webhook and the console's Auto-deploy tab.
const log = createDeliveryLog();

export const githubWebhook = {
  method: 'post',
  path: '/github-webhook/:service',
  description: 'Restart a Swarm service when a signed default-branch push matches its Git clone URL',
  onRequest: createWebhookHandler({log})
};

import {configuredAdmin} from '../admin.mjs';
const admin = configuredAdmin(process.env, {deliveryLog: log});
const route = (method, path, onRequest) => ({method, path, onRequest});
export const adminPage = route('get', '/admin', admin.page);
export const adminScript = route('get', '/admin/app.js', admin.script);
export const adminStyle = route('get', '/admin/style.css', admin.style);
export const adminConfig = route('get', '/admin/api/config', admin.config);
export const adminLogin = route('post', '/admin/api/login', admin.login);
export const adminSession = route('get', '/admin/api/session', admin.session);
export const adminLogout = route('post', '/admin/api/logout', admin.logout);
export const adminEndSessions = route('post', '/admin/api/sessions/end', admin.endSessions);
export const adminSwarm = route('get', '/admin/api/swarm', admin.swarm);
export const adminUsers = route('get', '/admin/api/users', admin.users);
export const adminSaveUsers = route('post', '/admin/api/users', admin.saveUsers);
export const adminServices = route('get', '/admin/api/services', admin.list);
export const adminCreate = route('post', '/admin/api/services', admin.create);
export const adminService = route('get', '/admin/api/services/:service', admin.detail);
export const adminUpdate = route('post', '/admin/api/services/:service', admin.update);
export const adminAction = route('post', '/admin/api/services/:service/actions', admin.action);
export const adminTasks = route('get', '/admin/api/services/:service/tasks', admin.tasks);
export const adminLogs = route('get', '/admin/api/services/:service/logs', admin.logs);
export const adminWebhook = route('get', '/admin/api/services/:service/webhook', admin.webhook);
export const adminWebhookAction = route('post', '/admin/api/services/:service/webhook', admin.webhookAction);
export const adminSecrets = route('get', '/admin/api/services/:service/secrets', admin.secrets);
export const adminCreateSecret = route('post', '/admin/api/services/:service/secrets', admin.createSecret);

// Public website and documentation.
import {configuredSite} from '../site.mjs';
const site = configuredSite();
export const siteHome = route('get', '/', site.home);
export const siteAsset = route('get', '/site/:file', site.asset);
export const siteDocsIndex = route('get', '/docs', site.docs);
export const siteDocs = route('get', '/docs/:doc', site.docs);
