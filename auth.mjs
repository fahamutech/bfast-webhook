// Google sign-in (through Firebase Authentication) and stateless session cookies.
import {createHmac, randomBytes} from 'node:crypto';
import {SignJWT, jwtVerify, createRemoteJWKSet} from 'jose';
import {fail} from './docker.mjs';

export const cookieName = '__Host-bfast-admin';
const email = /^[^\s@;:,]+@[^\s@;:,]+\.[^\s@;:,]+$/;
export const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const validEmail = value => email.test(value) && value.length <= 254;
export const validServiceName = value => /^[A-Za-z0-9][\w.-]{0,127}$/.test(value || '');

// ADMIN_EMAILS=a@x.com,b@x.com
// SERVICE_USERS=alice@x.com:demo_faas,shop_faas;bob@x.com:shop_faas
export function parseAccess(adminEmails = '', serviceUsers = '') {
  const admins = new Set((adminEmails || '').split(',').map(normalizeEmail).filter(validEmail));
  const users = new Map();
  for (const entry of (serviceUsers || '').split(';')) {
    const index = entry.indexOf(':');
    if (index < 0) continue;
    const user = normalizeEmail(entry.slice(0, index));
    if (!validEmail(user)) continue;
    const services = entry.slice(index + 1).split(',').map(s => s.trim()).filter(validServiceName);
    users.set(user, new Set([...(users.get(user) || []), ...services]));
  }
  return {admins, users};
}

export function serializeUsers(users) {
  return [...users.entries()].filter(([, services]) => services.size)
    .map(([user, services]) => `${user}:${[...services].join(',')}`).join(';');
}

export function usersInput(input) {
  if (!Array.isArray(input) || input.length > 200) throw fail(400, 'Provide a list of users');
  const users = new Map();
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['email', 'services'].includes(k))) throw fail(400, 'Invalid user entry');
    const user = normalizeEmail(item.email);
    if (!validEmail(user) || users.has(user)) throw fail(400, `Invalid or duplicate email: ${String(item.email).slice(0, 80)}`);
    if (!Array.isArray(item.services) || item.services.length > 100 || item.services.some(s => !validServiceName(s))) throw fail(400, `Invalid service list for ${user}`);
    users.set(user, new Set(item.services));
  }
  return users;
}

export function createFirebaseVerifier(projectId) {
  const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
  return async idToken => {
    if (typeof idToken !== 'string' || idToken.length > 4096) throw fail(401, 'Sign in with Google first');
    let payload;
    try {
      ({payload} = await jwtVerify(idToken, jwks, {algorithms: ['RS256'], issuer: `https://securetoken.google.com/${projectId}`, audience: projectId}));
    } catch { throw fail(401, 'Google sign-in could not be verified. Sign in again.'); }
    const provider = payload.firebase?.sign_in_provider;
    const address = normalizeEmail(payload.email);
    if (!payload.sub || provider !== 'google.com' || !validEmail(address) || payload.email_verified !== true) throw fail(401, 'Only verified Google accounts can sign in');
    return {email: address, name: typeof payload.name === 'string' ? payload.name.slice(0, 120) : address, picture: typeof payload.picture === 'string' && payload.picture.startsWith('https://') ? payload.picture : null};
  };
}

export function createSessions({jwtSecret, origin, ttl = 8 * 3600, now = () => Date.now()}) {
  const key = Buffer.from(jwtSecret);
  const revoked = new Map();
  const csrfFor = jti => createHmac('sha256', key).update(`csrf:${jti}`).digest('hex');
  return {
    ttl,
    cookie: (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`,
    async issue(user) {
      const jti = randomBytes(24).toString('hex'), iat = Math.floor(now() / 1000);
      const token = await new SignJWT({name: user.name, picture: user.picture}).setProtectedHeader({alg: 'HS256', typ: 'JWT'})
        .setIssuer(origin).setAudience('bfast-admin').setSubject(user.email).setJti(jti).setIssuedAt(iat).setExpirationTime(iat + ttl).sign(key);
      return {token, csrf: csrfFor(jti)};
    },
    async verify(cookieHeader) {
      for (const [jti, expires] of revoked) if (expires <= now()) revoked.delete(jti);
      try {
        const token = (cookieHeader || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
        const {payload} = await jwtVerify(token, key, {algorithms: ['HS256'], issuer: origin, audience: 'bfast-admin', currentDate: new Date(now())});
        if (!payload.sub || !payload.jti || revoked.has(payload.jti)) throw new Error();
        return {...payload, email: payload.sub, csrf: csrfFor(payload.jti)};
      } catch { throw fail(401, 'Please sign in'); }
    },
    revoke(claims) { if (revoked.size < 10000) revoked.set(claims.jti, (claims.exp || 0) * 1000); }
  };
}
