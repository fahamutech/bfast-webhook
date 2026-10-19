// Service classification, read models and Swarm spec builders.
import {fail} from './docker.mjs';

export const projectLabel = 'bfast.project';
const env = list => Object.fromEntries((list || []).map(entry => {
  const index = entry.indexOf('=');
  return index < 0 ? [entry, ''] : [entry.slice(0, index), entry.slice(index + 1)];
}));

// 'app': editable application service. 'control': this management service itself.
// 'protected': infrastructure (Traefik, BFast API, bind mounts, manager-only, global) — read-only.
export function classify(service, {excluded = [], selfName = 'webhook'} = {}) {
  const spec = service.Spec || {}, task = spec.TaskTemplate || {}, container = task.ContainerSpec || {};
  const name = spec.Name || '';
  if (name && name === selfName) return 'control';
  const editable = Boolean(spec.Mode?.Replicated && !excluded.includes(name)
    && !/(^|_)(webhook|traefik|bfast|control)(_|$)/i.test(name)
    && spec.Labels?.['bfast.control'] !== 'true' && spec.Labels?.['bfast.app'] !== 'bfast'
    && !(container.Env || []).includes('PROJECT_ID=_BFAST_ADMIN')
    && !(container.Mounts || []).some(m => m.Type === 'bind')
    && !(task.Placement?.Constraints || []).some(c => /node\.role\s*==\s*manager/i.test(c)));
  return editable ? 'app' : 'protected';
}
export const isEditable = (service, excluded = []) => classify(service, {excluded, selfName: '\0'}) === 'app';

export function serviceSummary(service, tasks = [], kind = 'app') {
  const spec = service.Spec, t = spec.TaskTemplate, variables = env(t.ContainerSpec.Env);
  const replicas = spec.Mode?.Replicated ? (spec.Mode.Replicated.Replicas ?? 1) : null;
  const states = {};
  for (const task of tasks) states[task.Status?.State || 'unknown'] = (states[task.Status?.State || 'unknown'] || 0) + 1;
  const running = states.running || 0;
  const hosts = Object.entries(spec.Labels || {}).filter(([k]) => /^traefik\.http\.routers\..*\.rule$/.test(k))
    .flatMap(([, rule]) => [...rule.matchAll(/`([^`]+)`/g)].map(m => m[1]));
  return {id: service.ID, name: spec.Name, kind, image: t.ContainerSpec.Image?.replace(/@sha256:.*$/, '') || '',
    mode: spec.Mode?.Global ? 'global' : 'replicated', replicas, running, states,
    archived: replicas === 0,
    status: replicas === 0 ? 'archived' : running >= (replicas ?? 1) ? 'running' : running > 0 ? 'degraded' : 'starting',
    project: spec.Labels?.[projectLabel] || variables.PROJECT_ID || null, hosts,
    gitCloneUrl: variables.GIT_CLONE_URL || null, modeEnv: variables.MODE || null,
    createdAt: service.CreatedAt, updatedAt: service.UpdatedAt, version: service.Version?.Index};
}

export function serviceDetail(service) {
  const t = service.Spec.TaskTemplate;
  return {id: service.ID, name: service.Spec.Name, version: service.Version.Index,
    image: t.ContainerSpec.Image, env: t.ContainerSpec.Env || [],
    replicas: service.Spec.Mode.Replicated?.Replicas ?? 1,
    cpus: (t.Resources?.Limits?.NanoCPUs || 0) / 1e9,
    memoryMB: (t.Resources?.Limits?.MemoryBytes || 0) / 1048576,
    restart: t.RestartPolicy?.Condition || 'any',
    labels: service.Spec.Labels || {}, constraints: t.Placement?.Constraints || [],
    networks: (t.Networks || []).map(n => n.Target)};
}

export function taskSummary(task, nodes = new Map()) {
  return {id: task.ID, slot: task.Slot ?? null, node: nodes.get(task.NodeID) || task.NodeID || null,
    state: task.Status?.State || 'unknown', desired: task.DesiredState || null,
    message: task.Status?.Message || '', error: task.Status?.Err || '',
    exitCode: task.Status?.ContainerStatus?.ExitCode ?? null, updatedAt: task.Status?.Timestamp || task.UpdatedAt};
}

export const validEnv = entry => typeof entry === 'string' && entry.length <= 131000 && !entry.includes('\0') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(entry);
export function checkEnv(list) {
  if (!Array.isArray(list) || list.length > 300) throw fail(400, 'Invalid environment variables');
  const keys = new Set();
  for (const entry of list) {
    if (!validEnv(entry)) throw fail(400, 'Use valid KEY=value environment variables');
    const key = entry.slice(0, entry.indexOf('='));
    if (keys.has(key)) throw fail(400, `Duplicate environment variable ${key}`);
    keys.add(key);
  }
  return list;
}
const validImage = value => typeof value === 'string' && value.length <= 255 && /^[a-z0-9][a-z0-9._\/-]*(?::[\w.-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/i.test(value) && !/\s/.test(value);
export function checkDeployment(input) {
  if (!Number.isInteger(input.replicas) || input.replicas < 0 || input.replicas > 100
    || !Number.isFinite(input.cpus) || input.cpus < 0 || input.cpus > 128
    || !Number.isFinite(input.memoryMB) || input.memoryMB < 0 || input.memoryMB > 1048576
    || !['any', 'on-failure', 'none'].includes(input.restart)) throw fail(400, 'Invalid deployment settings');
}

export function updatedSpec(service, input, {allowImage = false} = {}) {
  const allowed = ['version', 'env', 'replicas', 'cpus', 'memoryMB', 'restart', 'secrets', ...(allowImage ? ['image'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw fail(400, 'Unsupported settings');
  if (!Number.isSafeInteger(input.version) || input.version !== service.Version.Index) throw fail(409, 'Service changed. Reload before saving.');
  checkEnv(input.env);
  checkDeployment(input);
  if (input.image !== undefined && !validImage(input.image)) throw fail(400, 'Invalid image reference');
  const spec = structuredClone(service.Spec);
  spec.TaskTemplate.ContainerSpec.Env = input.env;
  if (input.image !== undefined) spec.TaskTemplate.ContainerSpec.Image = input.image;
  spec.Mode.Replicated.Replicas = input.replicas;
  const t = spec.TaskTemplate;
  t.Resources ||= {}; t.Resources.Limits ||= {};
  t.Resources.Limits.NanoCPUs = Math.round(input.cpus * 1e9);
  t.Resources.Limits.MemoryBytes = Math.round(input.memoryMB * 1048576);
  t.RestartPolicy = {...t.RestartPolicy, Condition: input.restart};
  t.ForceUpdate = (t.ForceUpdate || 0) + 1;
  return spec;
}

// Archive scales to 0 and unarchive scales to 1. The rest of the spec is untouched.
export function actionSpec(service, action) {
  const spec = structuredClone(service.Spec), current = spec.Mode.Replicated?.Replicas ?? 1;
  if (action === 'archive') {
    if (current === 0) throw fail(400, 'Service is already archived');
    spec.Mode.Replicated.Replicas = 0;
  } else if (action === 'unarchive') {
    if (current > 0) throw fail(400, 'Service is not archived');
    spec.Mode.Replicated.Replicas = 1;
  } else if (action === 'restart') {
    if (current === 0) throw fail(400, 'Unarchive the service before restarting it');
    spec.TaskTemplate.ForceUpdate = (spec.TaskTemplate.ForceUpdate || 0) + 1;
  } else throw fail(400, 'Unknown action');
  return spec;
}

const validProject = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,40}$/.test(value);
const validHost = value => typeof value === 'string' && value.length <= 253 && /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
export function newServiceSpec(input, {cluster, hostDomain, defaultImage, network = 'bfastweb'}) {
  const allowed = ['project', 'image', 'env', 'replicas', 'cpus', 'memoryMB', 'restart', 'hosts', 'sticky'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw fail(400, 'Unsupported service settings');
  if (!validProject(input.project)) throw fail(400, 'Project ID must be 2–41 lowercase letters, numbers or dashes');
  const image = input.image === undefined || input.image === '' ? defaultImage : input.image;
  if (!validImage(image)) throw fail(400, 'Invalid image reference');
  checkDeployment(input);
  const project = input.project, name = `${project}_faas`, router = `${project}-faas`;
  const defaults = cluster && hostDomain ? [`${router}.${cluster}.${hostDomain}`, `${project}.api.${hostDomain}`] : [];
  const extra = input.hosts === undefined ? [] : input.hosts;
  if (!Array.isArray(extra) || extra.length > 20 || extra.some(h => typeof h !== "string" || !validHost(h.trim().toLowerCase()))) throw fail(400, "Invalid hostnames");
  const hosts = [...new Set([...defaults, ...extra.map(h => h.trim().toLowerCase())])];
  if (!hosts.length) throw fail(400, 'Provide at least one hostname');
  const reserved = new Set(['PROJECT_ID', 'PORT', 'PRODUCTION']);
  const variables = checkEnv(input.env === undefined ? [] : input.env).filter(e => !reserved.has(e.slice(0, e.indexOf('='))));
  const labels = {'traefik.docker.network': network, 'traefik.enable': 'true',
    [`traefik.http.services.${router}.loadbalancer.server.port`]: '3000',
    [`traefik.http.routers.${router}.rule`]: hosts.map(h => `Host(\`${h}\`)`).join(' || '),
    [`traefik.http.routers.${router}.tls`]: 'true',
    [`traefik.http.routers.${router}.tls.certresolver`]: 'le',
    [projectLabel]: project};
  if (input.sticky !== false) labels[`traefik.http.services.${router}.loadbalancer.sticky.cookie`] = 'true';
  const spec = {Name: name, Labels: labels,
    TaskTemplate: {ContainerSpec: {Image: image, Hostname: name, Env: [`PROJECT_ID=${project}`, 'PORT=3000', 'PRODUCTION=1', ...variables]},
      Resources: {Limits: {NanoCPUs: Math.round(input.cpus * 1e9), MemoryBytes: Math.round(input.memoryMB * 1048576)}},
      RestartPolicy: {Condition: input.restart, Delay: 5_000_000_000}, Networks: [{Target: network}]},
    Mode: {Replicated: {Replicas: input.replicas}}};
  return spec;
}

export function nodeSummary(node) {
  return {id: node.ID, hostname: node.Description?.Hostname || node.ID, role: node.Spec?.Role || 'worker',
    availability: node.Spec?.Availability || 'active', state: node.Status?.State || 'unknown', address: node.Status?.Addr || '',
    leader: Boolean(node.ManagerStatus?.Leader), reachability: node.ManagerStatus?.Reachability || null,
    cpus: (node.Description?.Resources?.NanoCPUs || 0) / 1e9, memoryGB: Math.round((node.Description?.Resources?.MemoryBytes || 0) / 1073741824 * 10) / 10,
    engine: node.Description?.Engine?.EngineVersion || '', os: node.Description?.Platform ? `${node.Description.Platform.OS}/${node.Description.Platform.Architecture}` : ''};
}
