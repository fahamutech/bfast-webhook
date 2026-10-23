// Service classification, read models and Swarm spec builders.
import {fail} from './docker.mjs';
import {repositoryFromCloneUrl, pausedLabel} from './webhook.mjs';

export const projectLabel = 'bfast.project';
const env = list => Object.fromEntries((list || []).map(entry => {
  const index = entry.indexOf('=');
  return index < 0 ? [entry, ''] : [entry.slice(0, index), entry.slice(index + 1)];
}));

// 'app': editable application service. 'control': this management service itself.
// 'protected': infrastructure (Traefik, BFast API, bind mounts, manager-only, global) — read-only.
// A service that must keep local state (a bind mount, or a manager constraint) can opt in to being managed here
// with the label bfast.managed=true. Editing it keeps its mounts and constraints; the Docker socket is never allowed.
export const managedLabel = 'bfast.managed';
export function classify(service, {excluded = [], selfName = 'webhook'} = {}) {
  const spec = service.Spec || {}, task = spec.TaskTemplate || {}, container = task.ContainerSpec || {};
  const name = spec.Name || '';
  if (name && name === selfName) return 'control';
  const optedIn = spec.Labels?.[managedLabel] === 'true';
  const mounts = container.Mounts || [];
  const editable = Boolean(spec.Mode?.Replicated && !excluded.includes(name)
    && !/(^|_)(webhook|traefik|bfast|control)(_|$)/i.test(name)
    && spec.Labels?.['bfast.control'] !== 'true' && spec.Labels?.['bfast.app'] !== 'bfast'
    && !(container.Env || []).includes('PROJECT_ID=_BFAST_ADMIN')
    && !mounts.some(m => /docker\.sock/.test(m.Source || m.Target || ''))
    && (optedIn || !mounts.some(m => m.Type === 'bind'))
    && (optedIn || !(task.Placement?.Constraints || []).some(c => /node\.role\s*==\s*manager/i.test(c))));
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
    autoDeploy: autoDeployState(variables, spec.Labels),
    createdAt: service.CreatedAt, updatedAt: service.UpdatedAt, version: service.Version?.Index};
}

// 'on' when a GitHub push can redeploy the service, 'paused' when switched off, 'off' when not a Git service.
export function autoDeployState(variables, labels) {
  if ((variables.MODE?.trim() || 'git') !== 'git' || !repositoryFromCloneUrl(variables.GIT_CLONE_URL)) return 'off';
  return labels?.[pausedLabel] === 'true' ? 'paused' : 'on';
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
    mounts: (t.ContainerSpec.Mounts || []).filter(m => ['bind', 'volume'].includes(m.Type)).map(mountSummary),
    updateOrder: service.Spec.UpdateConfig?.Order || 'stop-first', updateParallelism: service.Spec.UpdateConfig?.Parallelism ?? 1,
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
export const validImage = value => typeof value === 'string' && value.length <= 255 && /^[a-z0-9][a-z0-9._\/-]*(?::[\w.-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/i.test(value) && !/\s/.test(value);
export function checkDeployment(input) {
  if (!Number.isInteger(input.replicas) || input.replicas < 0 || input.replicas > 100
    || !Number.isFinite(input.cpus) || input.cpus < 0 || input.cpus > 128
    || !Number.isFinite(input.memoryMB) || input.memoryMB < 0 || input.memoryMB > 1048576
    || !['any', 'on-failure', 'none'].includes(input.restart)) throw fail(400, 'Invalid deployment settings');
}

// ---------- placement, storage and rollout: administrator settings ----------
const constraintPattern = /^(node\.(id|hostname|role|platform\.os|platform\.arch)|node\.labels\.[A-Za-z0-9_.-]{1,100}|engine\.labels\.[A-Za-z0-9_.-]{1,100})(==|!=)[A-Za-z0-9_.:\/@-]{1,200}$/;
export function checkConstraints(list) {
  if (!Array.isArray(list) || list.length > 10) throw fail(400, 'Invalid placement constraints');
  const out = list.map(c => {
    const clean = typeof c === 'string' ? c.replace(/\s*(==|!=)\s*/, '$1').trim() : '';
    if (!constraintPattern.test(clean)) throw fail(400, `Unsupported constraint "${String(c).slice(0, 80)}". Use node.hostname==name, node.role==manager, or node.labels.key==value`);
    return clean;
  });
  return [...new Set(out)];
}

// ADMIN_ALLOWED_MOUNT_ROOTS=/var/lib,/srv — host folders services may mount. Empty means host mounts are disabled.
const cleanPath = (value, what) => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 255 || /[\0\s]/.test(value) || value.split('/').includes('..')) throw fail(400, `${what} must be an absolute path without spaces or ..`);
  const path = value.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return path;
};
export const parseMountRoots = value => [...new Set(String(value || '').split(/[\s,]+/).filter(Boolean).map(r => { try { return cleanPath(r, 'Mount root'); } catch { return null; } }).filter(r => r && r !== '/'))];
const deniedHostPaths = [/^\/$/, /^\/(etc|boot|proc|sys|dev|run|bin|sbin|usr|lib|lib64|var\/run)(\/|$)/, /docker\.sock/, /(^|\/)\.(ssh|docker|aws|gnupg|kube)(\/|$)/];
const underRoot = (path, roots) => roots.some(r => path === r || path.startsWith(r + '/'));
function checkHostPath(value, roots) {
  const path = cleanPath(value, 'Host folder');
  if (!roots.length) throw fail(400, 'Host folder mounts are disabled. Set ADMIN_ALLOWED_MOUNT_ROOTS on the management service to the folders services may use.');
  if (deniedHostPaths.some(re => re.test(path))) throw fail(400, `${path} cannot be mounted`);
  if (!underRoot(path, roots)) throw fail(400, `${path} is outside ADMIN_ALLOWED_MOUNT_ROOTS (${roots.join(', ')})`);
  return path;
}
export function checkMounts(list, {roots = []} = {}) {
  if (!Array.isArray(list) || list.length > 10) throw fail(400, 'Invalid storage mounts');
  const targets = new Set();
  return list.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['type', 'source', 'hostPath', 'target', 'readOnly'].includes(k))) throw fail(400, 'Invalid mount');
    if (!['bind', 'volume'].includes(item.type)) throw fail(400, 'Mount type must be bind or volume');
    const target = cleanPath(item.target, 'Container path');
    if (/^\/(proc|sys|dev)(\/|$)/.test(target) || /docker\.sock/.test(target)) throw fail(400, `${target} cannot be a mount target`);
    if (targets.has(target)) throw fail(400, `Two mounts use ${target}`);
    targets.add(target);
    if (item.readOnly !== undefined && typeof item.readOnly !== 'boolean') throw fail(400, 'readOnly must be true or false');
    const mount = {Type: item.type, Target: target, ReadOnly: item.readOnly === true};
    if (item.type === 'bind') mount.Source = checkHostPath(item.source, roots);
    else {
      if (typeof item.source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(item.source)) throw fail(400, 'Volume names use letters, numbers, dots, dashes and underscores');
      mount.Source = item.source;
      if (item.hostPath) mount.VolumeOptions = {DriverConfig: {Name: 'local', Options: {type: 'none', o: 'bind', device: checkHostPath(item.hostPath, roots)}}};
    }
    return mount;
  });
}
export const mountSummary = mount => {
  const options = mount.VolumeOptions?.DriverConfig?.Options;
  return {type: mount.Type, source: mount.Source || '', hostPath: options?.o?.includes('bind') ? options.device : undefined, target: mount.Target, readOnly: Boolean(mount.ReadOnly)};
};

export const routerRuleKey = labels => Object.keys(labels || {}).find(k => /^traefik\.http\.routers\.[^.]+\.rule$/.test(k));
export function checkHosts(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 20 || list.some(h => typeof h !== 'string' || !validHost(h.trim().toLowerCase()))) throw fail(400, 'Provide 1 to 20 valid hostnames');
  return [...new Set(list.map(h => h.trim().toLowerCase()))];
}
export const hostRule = hosts => hosts.map(h => `Host(\`${h}\`)`).join(' || ');
export const PLACEMENT_KEYS = ['constraints', 'mounts', 'hosts', 'updateOrder', 'updateParallelism'];
// The placement settings a request really changes. Values sent back as they already are count as no change, so a
// service whose mounts were set up on the command line can still be saved from the console.
export function placementChanges(service, input) {
  const current = {...serviceDetail(service), hosts: serviceSummary(service, [], 'app').hosts};
  const canon = {
    constraints: list => (Array.isArray(list) ? list : []).map(c => String(c).replace(/\s*(==|!=)\s*/, '$1').trim()),
    hosts: list => (Array.isArray(list) ? list : []).map(h => String(h).trim().toLowerCase()),
    mounts: list => (Array.isArray(list) ? list : []).map(m => ({type: m?.type, source: m?.source || '', hostPath: m?.hostPath || undefined, target: m?.target, readOnly: m?.readOnly === true}))
  };
  const same = (k, a, b) => JSON.stringify(canon[k] ? canon[k](a) : a) === JSON.stringify(canon[k] ? canon[k](b) : b);
  return PLACEMENT_KEYS.filter(k => input?.[k] !== undefined && !same(k, input[k], current[k]));
}

export function updatedSpec(service, input, {allowImage = false, mountRoots = []} = {}) {
  const allowed = ['version', 'env', 'replicas', 'cpus', 'memoryMB', 'restart', 'secrets', ...PLACEMENT_KEYS, ...(allowImage ? ['image'] : [])];
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
  applyPlacement(spec, {...input, ...Object.fromEntries(PLACEMENT_KEYS.filter(k => !placementChanges(service, input).includes(k)).map(k => [k, undefined]))}, mountRoots);
  t.ForceUpdate = (t.ForceUpdate || 0) + 1;
  return spec;
}

// Applies the optional placement, storage, domain and rollout settings. Fields left out stay as they are.
function applyPlacement(spec, input, mountRoots) {
  const t = spec.TaskTemplate;
  if (input.constraints !== undefined) {
    const constraints = checkConstraints(input.constraints);
    t.Placement = {...t.Placement, Constraints: constraints};
    if (!constraints.length) delete t.Placement.Constraints;
  }
  if (input.mounts !== undefined) {
    const kept = (t.ContainerSpec.Mounts || []).filter(m => !['bind', 'volume'].includes(m.Type));
    const mounts = [...kept, ...checkMounts(input.mounts, {roots: mountRoots})];
    if (mounts.length) t.ContainerSpec.Mounts = mounts; else delete t.ContainerSpec.Mounts;
  }
  if (input.hosts !== undefined) {
    const key = routerRuleKey(spec.Labels);
    if (!key) throw fail(400, 'This service has no Traefik router to change hostnames on');
    spec.Labels[key] = hostRule(checkHosts(input.hosts));
  }
  if (input.updateOrder !== undefined || input.updateParallelism !== undefined) {
    if (input.updateOrder !== undefined && !['stop-first', 'start-first'].includes(input.updateOrder)) throw fail(400, 'Update order must be stop-first or start-first');
    if (input.updateParallelism !== undefined && !(Number.isInteger(input.updateParallelism) && input.updateParallelism >= 0 && input.updateParallelism <= 20)) throw fail(400, 'Update parallelism must be a whole number from 0 to 20');
    spec.UpdateConfig = {...spec.UpdateConfig,
      ...(input.updateOrder !== undefined ? {Order: input.updateOrder} : {}),
      ...(input.updateParallelism !== undefined ? {Parallelism: input.updateParallelism} : {})};
  }
  // A service that now keeps local state would otherwise be classified as infrastructure and vanish from the console.
  if ((input.constraints !== undefined || input.mounts !== undefined) && classify({Spec: spec}, {selfName: '\0'}) === 'protected') {
    spec.Labels = {...spec.Labels, [managedLabel]: 'true'};
    if (classify({Spec: spec}, {selfName: '\0'}) === 'protected') throw fail(400, 'Those placement or storage settings are not allowed for this service');
  }
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
// ALLOWED_IMAGES=img:a,img:b — comma or whitespace separated, invalid entries ignored.
export const parseImages = value => [...new Set(String(value || '').split(/[\s,]+/).map(s => s.trim()).filter(validImage))];

export function newServiceSpec(input, {cluster, hostDomain, defaultImage, images = [], network = 'bfastweb'}) {
  const allowed = ['project', 'image', 'env', 'replicas', 'cpus', 'memoryMB', 'restart', 'hosts', 'sticky'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw fail(400, 'Unsupported service settings');
  if (!validProject(input.project)) throw fail(400, 'Project ID must be 2–41 lowercase letters, numbers or dashes');
  const image = input.image === undefined || input.image === '' ? defaultImage : input.image;
  if (!validImage(image)) throw fail(400, 'Invalid image reference');
  if (images.length ? !images.includes(image) : image !== defaultImage) throw fail(400, images.length ? 'Choose an image from ALLOWED_IMAGES' : `Only ${defaultImage} is allowed. Add images to ALLOWED_IMAGES on the management service to offer more.`);
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
