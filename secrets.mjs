// Secret contents are write-only. Ownership prevents attaching another service's
// credentials (particularly manager credentials) to an editable application.
const ownerLabel = 'bfast.admin.service';
const fail = (status, message) => Object.assign(new Error(message), {status});
const filename = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const secretReference = ref => ({id: ref.SecretID, name: ref.SecretName,
  target: ref.File?.Name, uid: ref.File?.UID ?? '0', gid: ref.File?.GID ?? '0',
  mode: ref.File?.Mode ?? 0o444});

export async function secretChoices(docker, service, isEditable) {
  const [secrets, services] = await Promise.all([docker('GET', '/secrets'), docker('GET', '/services')]);
  const protectedIDs = new Set(services.filter(s => !isEditable(s))
    .flatMap(s => (s.Spec.TaskTemplate?.ContainerSpec?.Secrets || []).map(r => r.SecretID)));
  const attached = new Set((service.Spec.TaskTemplate.ContainerSpec.Secrets || []).map(r => r.SecretID));
  return secrets.filter(s => !protectedIDs.has(s.ID) &&
    (s.Spec.Labels?.[ownerLabel] === service.ID || attached.has(s.ID)))
    .map(s => ({id: s.ID, name: s.Spec.Name}));
}

export function newSecret(service, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some(k => !['name', 'value'].includes(k)) ||
    typeof input.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(input.name) ||
    typeof input.value !== 'string' || !input.value.length || Buffer.byteLength(input.value) > 65536) {
    throw fail(400, 'Provide a name (1–32 letters, numbers, dots, dashes or underscores) and a value (1–65536 UTF-8 bytes)');
  }
  return {Name: `app-${service.ID}-${input.name}`, Labels: {[ownerLabel]: service.ID},
    Data: Buffer.from(input.value, 'utf8').toString('base64')};
}

export function secretAttachments(service, input, choices) {
  if (!Array.isArray(input) || input.length > 100) throw fail(400, 'Invalid secret attachments');
  const allowed = new Map(choices.map(s => [s.id,s.name]));
  const current = new Map((service.Spec.TaskTemplate.ContainerSpec.Secrets || []).map(s => [s.SecretID,s]));
  const ids = new Set(), targets = new Set();
  return input.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(k => !['id','target','uid','gid','mode'].includes(k)) ||
      typeof ref.id !== 'string' || ids.has(ref.id) || typeof ref.target !== 'string' || !filename.test(ref.target) ||
      targets.has(ref.target) || typeof ref.uid !== 'string' || typeof ref.gid !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(ref.uid) || !/^(0|[1-9][0-9]{0,9})$/.test(ref.gid) ||
      Number(ref.uid) > 4294967294 || Number(ref.gid) > 4294967294 || ![0o400,0o440,0o444].includes(ref.mode)) {
      throw fail(400, 'Invalid or duplicate secret mount. Use a filename, numeric UID/GID and read-only permissions.');
    }
    if (!allowed.has(ref.id)) throw fail(403, 'Secret is unavailable for this application');
    ids.add(ref.id); targets.add(ref.target);
    return {...current.get(ref.id), SecretID:ref.id, SecretName:allowed.get(ref.id),
      File:{Name:ref.target, UID:String(ref.uid), GID:String(ref.gid), Mode:ref.mode}};
  });
}
