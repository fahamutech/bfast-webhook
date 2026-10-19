# bfast-webhook

GitHub push webhook **and** Docker Swarm service manager for BFast Cloud. Deploy
this public repository as a FaaS service named `webhook` on a Swarm manager.

- `POST /github-webhook/<service>` restarts a service after a signed default-branch
  push whose repository matches that service's `GIT_CLONE_URL`.
- `GET /` is the public BFast Cloud website, and `GET /docs` serves documentation
  pulled live from the public bfast-functions, bfast-tools and bfast-webhook READMEs.
- `GET /admin` is a web console where people sign in with Google (Firebase
  Authentication, project `bfastapp`) and manage the services assigned to them:
  view, create, archive (scale to 0), unarchive (scale to 1), restart, environment
  variables, GitHub auto-deploy settings and delivery history, Docker secrets, recent tasks, logs, Swarm status and user access.

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
  --env ADMIN_ORIGIN=https://webhook-faas.bfast.<bfast-cloud-host-domain> \
  --env ADMIN_EMAILS=you@gmail.com \
  --env SWARM_CLUSTER=bfast \
  --env SWARM_HOST_DOMAIN=<bfast-cloud-host-domain> \
  --env PORT=3000 \
  --label traefik.enable=true \
  --label traefik.docker.network=bfastweb \
  --label 'traefik.http.routers.webhook.rule=Host(`webhook-faas.bfast.<bfast-cloud-host-domain>`)' \
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
  --env-add ADMIN_ORIGIN=https://webhook-faas.bfast.<bfast-cloud-host-domain> \
  --env-add ADMIN_EMAILS=you@gmail.com \
  --env-add SWARM_CLUSTER=bfast \
  --env-add SWARM_HOST_DOMAIN=<bfast-cloud-host-domain> \
  --force webhook
```

`docker service update --secret-rm bfast_admin_password webhook` can remove the
old password secret afterwards.

## GitHub webhook settings

The easiest way is the service's **Auto-deploy** tab in the console, which shows
the exact values to paste. In the *source functions repository*, open
Settings → Webhooks → Add webhook:

- Payload URL: `https://webhook-faas.bfast.<bfast-cloud-host-domain>/github-webhook/example_faas`
- Content type: `application/json`
- Secret: the service's own secret from the Auto-deploy tab. The shared
  `github_webhook_secret` value also works unless `WEBHOOK_ACCEPT_SHARED_SECRET=false`.
- Events: push only

The target service must use `MODE=git` (or omit `MODE`, which defaults to `git`)
and have `GIT_CLONE_URL` pointing to the sending GitHub repository. HTTP(S)
GitHub clone URLs are supported, with or without `.git` or a trailing slash;
repository names are compared without case sensitivity. The receiver reads
`repository.default_branch` from GitHub's signed payload, so pushes to `main`,
`master`, or any other default branch trigger an update. Pushes to other branches
and branch deletions are ignored.

A 403 response means the URL names a different service, the target is not in Git
mode, or its `GIT_CLONE_URL` does not match the sending repository. Signature
failures return 401. Docker inspection/update failures return 500 and can be retried.

### Per-service secrets

Each service gets its own webhook secret, derived from `github_webhook_secret` with
HMAC-SHA256 over the service name and a generation number. Nothing extra is stored:
the generation lives in the service label `bfast.webhook.generation`. A user who can
see one service's secret cannot sign deliveries for another service. **Rotate secret**
bumps the generation, so the old value stops working immediately. **Pause** sets
`bfast.webhook.paused=true`; pushes are still recorded but do not restart the
service. Both are label-only updates and do not restart running tasks.

Verification tries the shared secret first without contacting Docker. Otherwise it
reads the service labels to check the per-service secret; these unverified lookups
are limited to 60 per minute.

### Firebase Authentication (one-time)

The console signs people in with Google through Firebase project **bfastapp**
(web app *BFastIDE*, `1:311831913786:web:6be76738b599546b`). In the
[Firebase console](https://console.firebase.google.com/project/bfastapp/authentication):

1. **Sign-in method** → enable the **Google** provider.
2. **Settings → Authorized domains** → add the console host, e.g.
   `webhook-faas.bfast.<bfast-cloud-host-domain>`. Sign-in fails with
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
| `ADMIN_ORIGIN` | yes | Exact HTTPS origin of the console, no trailing slash, e.g. `https://cloud.smartstock.co.tz`. Other hostnames routed to the service keep serving GitHub webhooks, and their `/admin` page redirects here |
| `ADMIN_EMAILS` | yes | Comma-separated Google accounts with full administration |
| `SERVICE_USERS` | managed | `user@gmail.com:svc_a,svc_b;other@gmail.com:svc_b` — per-user service access. Edited from the **Users & access** page; you rarely set it by hand |
| `SWARM_CLUSTER`, `SWARM_HOST_DOMAIN` | recommended | Default hostnames for new services: `<project>-faas.<cluster>.<domain>` and `<project>.api.<domain>` |
| `DEFAULT_IMAGE` | no | Image offered when creating services (default `joshuamshana/bfastfunction:latest`) |
| `ALLOWED_IMAGES` | no | Comma-separated images administrators may pick for new or existing services, e.g. `joshuamshana/bfastfunction:latest,joshuamshana/bfastfunction:3.2.4`. Read live from the management service's environment. When unset, images are read-only and new services use `DEFAULT_IMAGE` |
| `SELF_SERVICE_NAME` | no | Swarm name of this service (default `webhook`), used to store users and to manage itself |
| `ADMIN_EXCLUDED_SERVICES` | no | Comma-separated service names to hide from everyone |
| `FIREBASE_WEB_CONFIG` | no | JSON web config of an alternative Firebase project |
| `SITE_REGISTER_URL` | no | Where the website's sign-up buttons go. Defaults to an email to `SITE_CONTACT_EMAIL`; point it at a registration page once self-service sign-up exists |
| `SITE_CONTACT_EMAIL` | no | Contact address shown on the website (default `fahamutechdevelopers@gmail.com`) |
| `WEBHOOK_ACCEPT_SHARED_SECRET` | no | Set `false` once every GitHub hook uses its per-service secret (default `true`) |

Missing `ADMIN_JWT_SECRET_FILE`, `ADMIN_ORIGIN` or `ADMIN_EMAILS` disables the
console with HTTP 503 without affecting the GitHub webhook.

## Roles

**Administrators** (`ADMIN_EMAILS`) see every application service plus the
`webhook` management service itself. They can create services, change
images, view Swarm nodes and all services, and assign users.

**Users** (`SERVICE_USERS`) sign in with Google and see only the services assigned
to them. They can edit environment variables and secrets, archive, unarchive and
restart, and read tasks and logs for those services. Their **Settings** tab is read
only: replicas, CPU and memory limits, restart policy and image can only be changed
by administrators, and the API rejects such changes from users.

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
the signed-in administrator, archive is refused, and its secrets are not
editable from the console. Saving users or any change to this service makes
Swarm restart it; sessions are stateless JWTs, so people stay signed in.

## Day-to-day workflow

- **Create**: *New service*. The console does not run `create_faas.sh`; it builds
  the same Swarm spec through the Docker API (name and hostname `<project>_faas`,
  `bfastweb` network, replicated, restart `any` with 5 s delay, Traefik port 3000,
  TLS with resolver `le`, sticky cookie, both default hostnames, `PROJECT_ID`,
  `PORT=3000`, `PRODUCTION=1`, extra env, image), plus optional CPU/memory limits,
  extra hostnames and user assignment. The form asks for project ID, image, `MODE`
  and source (`GIT_CLONE_URL`, `NPM_TAR` or `URL_TAR`), Git credentials, replicas,
  limits, extra hostnames and users. Create with 0 replicas to stage it archived.
- **Archive / Unarchive**: archive scales the service to 0 replicas; unarchive
  scales it to 1. Configuration, secrets and labels are kept. Raise replicas
  further from *Settings*.
- **Restart**: forces a rolling task replacement (same as a webhook deploy).
- **Auto-deploy**: payload URL, per-service secret (reveal/copy), readiness checks
  (`MODE=git` and a github.com `GIT_CLONE_URL`), a link to the repository's webhook
  settings, pause/resume, rotate secret, **Deploy now**, and the last 20 deliveries
  with result, branch, commit and pusher. History is in memory and resets when the
  management service restarts; signature failures are counted per service.
- **Environment**: text, file and Base64 values; removing a row deletes the
  variable. Saving redeploys.
- **Secrets**: create versioned Swarm secrets scoped to the service, attach them
  under `/run/secrets/<name>`, and point an environment variable at that path; the
  BFast runtime loads the file contents at startup. Values are write-only.
- **Logs**: last 100–1000 lines via the Docker service logs API, on demand or
  auto-refreshed every 10 s. Auto-refresh pauses when you switch to another tab or
  the browser tab is hidden, and resumes when you come back. Nothing streams continuously.
- **Swarm status** (admins): node roles, availability, resources, engine
  versions, and every service with running/desired counts.
- **Delete**: not available in the console by design. Archive instead, and use
  `docker service rm` on the manager if a service must really be removed.

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
| POST | `/admin/api/services/:service/actions` | signed in | `{ "action": "archive" \| "unarchive" \| "restart" }` |
| GET | `/admin/api/services/:service/tasks` | signed in | Recent tasks |
| GET | `/admin/api/services/:service/logs?tail=200` | signed in | Last lines (10–1000) |
| GET/POST | `/admin/api/services/:service/secrets` | signed in | List / create secrets |
| GET | `/admin/api/services/:service/webhook` | signed in | Auto-deploy settings, secret, readiness, deliveries |
| POST | `/admin/api/services/:service/webhook` | signed in | `{ "action": "rotate" \| "pause" \| "resume", "version": n }` |
| GET | `/admin/api/swarm` | admin | Swarm info, nodes, all services |
| GET/POST | `/admin/api/users` | admin | Read / replace `SERVICE_USERS` |

Writes require `Origin: <ADMIN_ORIGIN>`, `Content-Type: application/json` and
`X-CSRF-Token`. Updates must send the `version` returned by GET; HTTP 409 means
the service changed and must be reloaded. Sessions last 8 hours in
Secure/HttpOnly/SameSite=Strict cookies, responses are `no-store`, and the CSP
only allows Google/Firebase sign-in endpoints. Sign-in attempts are limited to 30
per minute per replica. Run one replica.

## Website and docs

`site.mjs` serves the landing page (`site/index.html`, `site.css`, `site.js`) and the
docs. Docs are listed in the `docs` array in `site.mjs`: each entry maps a URL slug
to a Markdown file in a public GitHub repository, or to a local file in
`site/content`. Files are fetched from `raw.githubusercontent.com`, cached for 15
minutes, and the last good copy is served if GitHub is unreachable. Raw HTML in the
Markdown is escaped, relative links to other listed docs stay on `/docs`, and other
relative links point to GitHub. To publish a new page, add an entry to the array.

The landing page needs no build step. Motion is CSS and a small canvas script,
paused off-screen and in background tabs, and disabled for visitors who ask for
reduced motion. Content stays visible without JavaScript.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Landing page |
| GET | `/docs`, `/docs/:slug` | Documentation |
| GET | `/site/:file` | Website assets |

## Layout

The console works from phones to wide monitors. Below 900 px the service list
and the service detail become separate screens with a back button; tabs scroll
sideways, tables scroll inside their card, and forms stack into one column.

## Tests

`npm test` runs the webhook and console tests against a mocked Docker API and a
mocked token verifier; no Docker or Google access is needed.
