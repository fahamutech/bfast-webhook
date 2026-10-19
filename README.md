# bfast-webhook

GitHub push webhook **and** Docker Swarm service manager for BFast Cloud. Deploy
this public repository as a FaaS service named `webhook` on a Swarm manager.

- `POST /github-webhook/<service>` restarts a service after a signed default-branch
  push whose repository matches that service's `GIT_CLONE_URL`.
- `GET /admin` is a web console where people sign in with Google (Firebase
  Authentication, project `bfastapp`) and manage the services assigned to them:
  view, create, start, archive (scale to 0), restart, delete, environment
  variables, Docker secrets, recent tasks, logs, Swarm status and user access.

## Runtime

`functions/index.mjs` exports BFast function descriptors served by the standard
`joshuamshana/bfastfunction` runtime. Enable `BFAST_RAW_BODY=true` so the webhook
can verify GitHub's signature against the original JSON bytes. The runtime clones
this repository on startup and installs `dependencies` (`jose`).

## Create the Swarm service

```bash
# GitHub webhook secret (same value entered in GitHub's webhook settings)
docker secret create github_webhook_secret /secure/path/github-webhook-secret
# Session signing key for the console
openssl rand -hex 32 | docker secret create bfast_admin_jwt -

docker service create \
  --name webhook \
  --replicas 1 \
  --constraint 'node.role==manager' \
  --user 0 \
  --network bfastweb \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --secret github_webhook_secret \
  --secret bfast_admin_jwt \
  --env MODE=git \
  --env GIT_CLONE_URL=https://github.com/fahamutech/bfast-webhook.git \
  --env BFAST_RAW_BODY=true \
  --env BFAST_BODY_LIMIT=25mb \
  --env WEBHOOK_SECRET_FILE=/run/secrets/github_webhook_secret \
  --env ADMIN_JWT_SECRET_FILE=/run/secrets/bfast_admin_jwt \
  --env ADMIN_ORIGIN=https://webhook-faas.bfast.smartstock.co.tz \
  --env ADMIN_EMAILS=you@gmail.com \
  --env SWARM_CLUSTER=bfast \
  --env SWARM_HOST_DOMAIN=smartstock.co.tz \
  --env PORT=3000 \
  --label traefik.enable=true \
  --label traefik.docker.network=bfastweb \
  --label 'traefik.http.routers.webhook.rule=Host(`webhook-faas.bfast.smartstock.co.tz`)' \
  --label traefik.http.routers.webhook.tls=true \
  --label traefik.http.routers.webhook.tls.certresolver=le \
  --label traefik.http.services.webhook.loadbalancer.server.port=3000 \
  joshuamshana/bfastfunction:latest
```

Docker socket access gives this service control of the manager. Only trusted
administrators should be listed in `ADMIN_EMAILS` or be able to change this service.

### Upgrade an existing webhook service

The console no longer uses a shared password. Remove the old settings and add the
Google-based ones (the service restarts and clones the latest code):

```bash
openssl rand -hex 32 | docker secret create bfast_admin_jwt - 2>/dev/null || true

docker service update \
  --secret-add bfast_admin_jwt \
  --env-rm ADMIN_PASSWORD_FILE \
  --env-add ADMIN_JWT_SECRET_FILE=/run/secrets/bfast_admin_jwt \
  --env-add ADMIN_ORIGIN=https://webhook-faas.bfast.smartstock.co.tz \
  --env-add ADMIN_EMAILS=you@gmail.com \
  --env-add SWARM_CLUSTER=bfast \
  --env-add SWARM_HOST_DOMAIN=smartstock.co.tz \
  --force webhook
```

`docker service update --secret-rm bfast_admin_password webhook` can remove the
old password secret afterwards.

### Firebase Authentication (one-time)

The console signs people in with Google through Firebase project **bfastapp**
(web app *BFastIDE*, `1:311831913786:web:6be76738b599546b`). In the
[Firebase console](https://console.firebase.google.com/project/bfastapp/authentication):

1. **Sign-in method** → enable the **Google** provider.
2. **Settings → Authorized domains** → add the console host, e.g.
   `webhook-faas.bfast.smartstock.co.tz`. Sign-in fails with
   `auth/unauthorized-domain` until this is done.

The server verifies each Firebase ID token against Google's public keys
(issuer `https://securetoken.google.com/bfastapp`, audience `bfastapp`), accepts
only the `google.com` provider with a verified email, then issues its own session
cookie. No service account is required. To use another Firebase project set
`FIREBASE_WEB_CONFIG` to its web config JSON (`projectId`, `apiKey`, `authDomain`,
`appId`).

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `WEBHOOK_SECRET_FILE` | yes | GitHub webhook secret file |
| `ADMIN_JWT_SECRET_FILE` | yes | 32+ character session signing key file |
| `ADMIN_ORIGIN` | yes | Exact HTTPS origin of the console, no trailing slash |
| `ADMIN_EMAILS` | yes | Comma-separated Google accounts with full administration |
| `SERVICE_USERS` | managed | `user@gmail.com:svc_a,svc_b;other@gmail.com:svc_b` — per-user service access. Edited from the **Users & access** page; you rarely set it by hand |
| `SWARM_CLUSTER`, `SWARM_HOST_DOMAIN` | recommended | Default hostnames for new services: `<project>-faas.<cluster>.<domain>` and `<project>.api.<domain>` |
| `DEFAULT_IMAGE` | no | Image offered when creating services (default `joshuamshana/bfastfunction:latest`) |
| `SELF_SERVICE_NAME` | no | Swarm name of this service (default `webhook`), used to store users and to manage itself |
| `ADMIN_EXCLUDED_SERVICES` | no | Comma-separated service names to hide from everyone |
| `FIREBASE_WEB_CONFIG` | no | JSON web config of an alternative Firebase project |

Missing `ADMIN_JWT_SECRET_FILE`, `ADMIN_ORIGIN` or `ADMIN_EMAILS` disables the
console with HTTP 503 without affecting the GitHub webhook.

## Roles

**Administrators** (`ADMIN_EMAILS`) see every application service plus the
`webhook` management service itself. They can create and delete services, change
images, view Swarm nodes and all services, and assign users.

**Users** (`SERVICE_USERS`) sign in with Google and see only the services assigned
to them. They can edit environment variables and secrets, change replicas and
limits, start, archive, restart, and read tasks and logs for those services.

Infrastructure is **protected** and read-only for everyone: global services,
services with bind mounts or manager-only constraints, names containing
`webhook`, `traefik`, `bfast` or `control` components, `bfast.app=bfast`,
`bfast.control=true`, `PROJECT_ID=_BFAST_ADMIN`, and `ADMIN_EXCLUDED_SERVICES`.
Add `bfast.control=true` to any other infrastructure service before exposing
the console.

### Managing the management service

Administrators can edit the `webhook` service's environment, image and limits
and restart it. Guard rails: replicas stay ≥ 1, `WEBHOOK_SECRET_FILE`,
`ADMIN_JWT_SECRET_FILE` and `ADMIN_ORIGIN` must stay set, `ADMIN_EMAILS` must keep
the signed-in administrator, archive/delete are refused, and its secrets are not
editable from the console. Saving users or any change to this service makes
Swarm restart it; sessions are stateless JWTs, so people stay signed in.

## Day-to-day workflow

- **Create**: *New service* → project ID, image, `MODE` and source
  (`GIT_CLONE_URL`, `NPM_TAR` or `URL_TAR`), replicas, limits, extra hostnames,
  users. The service is named `<project>_faas` on `bfastweb` with Traefik TLS labels
  matching `create_faas.sh`. Create with 0 replicas to stage it archived.
- **Archive / Start**: archive scales to 0 and remembers the replica count in the
  `bfast.archive.replicas` label; start restores it. Configuration and secrets stay.
- **Restart**: forces a rolling task replacement (same as a webhook deploy).
- **Environment**: text, file and Base64 values; removing a row deletes the
  variable. Saving redeploys.
- **Secrets**: create versioned Swarm secrets scoped to the service, attach them
  under `/run/secrets/<name>`, and point an environment variable at that path; the
  BFast runtime loads the file contents at startup. Values are write-only.
- **Logs**: last 100–1000 lines via the Docker service logs API, on demand or
  auto-refreshed every 10 s. Nothing streams continuously.
- **Swarm status** (admins): node roles, availability, resources, engine
  versions, and every service with running/desired counts.
- **Delete** (admins): type the service name to confirm. Secrets are kept.

## Routes

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/admin`, `/admin/app.js`, `/admin/style.css`, `/admin/api/config` | public | Console and Firebase web config |
| POST | `/admin/api/login` | public | `{ "idToken": "<Firebase ID token>" }` → session cookie + CSRF token |
| GET | `/admin/api/session` | signed in | Current user, role and CSRF token |
| POST | `/admin/api/logout` | signed in | Revoke session |
| GET | `/admin/api/services` | signed in | Visible services with status, replicas, hosts |
| POST | `/admin/api/services` | admin | Create a service |
| GET | `/admin/api/services/:service` | signed in | Detail, environment, secrets metadata, recent tasks |
| POST | `/admin/api/services/:service` | signed in | Update `version`, `env`, `replicas`, `cpus`, `memoryMB`, `restart`, optional `secrets`, admin-only `image` |
| DELETE | `/admin/api/services/:service` | admin | `{ "name": "<exact name>" }` |
| POST | `/admin/api/services/:service/actions` | signed in | `{ "action": "start" \| "archive" \| "stop" \| "restart" }` |
| GET | `/admin/api/services/:service/tasks` | signed in | Recent tasks |
| GET | `/admin/api/services/:service/logs?tail=200` | signed in | Last lines (10–1000) |
| GET/POST | `/admin/api/services/:service/secrets` | signed in | List / create secrets |
| GET | `/admin/api/swarm` | admin | Swarm info, nodes, all services |
| GET/POST | `/admin/api/users` | admin | Read / replace `SERVICE_USERS` |

Writes require `Origin: <ADMIN_ORIGIN>`, `Content-Type: application/json` and
`X-CSRF-Token`. Updates must send the `version` returned by GET; HTTP 409 means
the service changed and must be reloaded. Sessions last 8 hours in
Secure/HttpOnly/SameSite=Strict cookies, responses are `no-store`, and the CSP
only allows Google/Firebase sign-in endpoints. Sign-in attempts are limited to 30
per minute per replica. Run one replica.

## Tests

`npm test` runs the webhook and console tests against a mocked Docker API and a
mocked token verifier; no Docker or Google access is needed.
