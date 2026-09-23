# bfast-webhook

GitHub push webhook for BFast Cloud. Deploy this public repository as a FaaS
service named `webhook`. The target service name comes from the webhook URL:
`/github-webhook/<service>`. After verifying a signed default-branch push, the
handler reads that service's `GIT_CLONE_URL` from Docker. It restarts the service
only when the URL matches the repository in GitHub's signed payload.
No repository-to-service target list is required.

## Runtime

`functions/index.mjs` exports the BFast function descriptor, served directly by
the normal runtime. Use a `bfastfunction` image with `BFAST_RAW_BODY` support and
enable it so the handler can verify GitHub's signature against the original JSON
bytes. The standard health and function discovery endpoints remain available.

## Create the Swarm service

Create a random secret in a file outside this public repository, then add it as
a Docker secret using the same value entered in GitHub's webhook settings:

```bash
docker secret create github_webhook_secret /secure/path/github-webhook-secret
```

Run this on a Swarm manager after the repository is public:

```bash
docker service create \
  --name webhook \
  --replicas 1 \
  --constraint 'node.role==manager' \
  --user 0 \
  --network bfastweb \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --secret github_webhook_secret \
  --env MODE=git \
  --env GIT_CLONE_URL=https://github.com/fahamutech/bfast-webhook.git \
  --env BFAST_RAW_BODY=true \
  --env BFAST_BODY_LIMIT=25mb \
  --env WEBHOOK_SECRET_FILE=/run/secrets/github_webhook_secret \
  --env PORT=3000 \
  --label traefik.enable=true \
  --label traefik.docker.network=bfastweb \
  --label 'traefik.http.routers.webhook.rule=Host(`webhook-faas.bfast.smartstock.co.tz`)' \
  --label traefik.http.routers.webhook.tls=true \
  --label traefik.http.routers.webhook.tls.certresolver=le \
  --label traefik.http.services.webhook.loadbalancer.server.port=3000 \
  joshuamshana/bfastfunction:latest
```

The base image includes the Docker CLI. Docker socket access gives the webhook
service control of the manager, so only trusted maintainers should be able to
change this service or its GitHub webhook secret.

## GitHub webhook settings

In the *source functions repository*, open Settings → Webhooks → Add webhook:

- Payload URL: `https://webhook-faas.bfast.smartstock.co.tz/github-webhook/example_faas`
- Content type: `application/json`
- Secret: the value in `github_webhook_secret`
- Events: push only

The target service must use `MODE=git` (or omit `MODE`, which defaults to `git`)
and have `GIT_CLONE_URL` pointing to the sending GitHub repository. HTTP(S)
GitHub clone URLs are supported, with or without `.git` or a trailing slash;
repository names are compared without case sensitivity. The receiver reads `repository.default_branch` from
GitHub's signed payload, so pushes to `main`, `master`, or any other default
branch name trigger an update automatically. Pushes to other branches and branch
deletions are ignored. For a `MODE=git` function service, the new task clones the
repository's default branch on startup.

## Update an existing webhook service

This reloads the latest webhook code, enables raw body support, and removes the
old custom server and target-list settings:

```bash
docker service update \
  --image joshuamshana/bfastfunction:latest \
  --env-rm START_SCRIPT \
  --env-rm WEBHOOK_TARGETS_JSON \
  --env-add BFAST_RAW_BODY=true \
  --env-add BFAST_BODY_LIMIT=25mb \
  --force \
  webhook
```

A 403 response now means the URL names a different service, the target is not
in Git mode, or its `GIT_CLONE_URL` does not match the sending repository. Correct
the webhook URL or target service configuration, then redeliver the failed event.
Signature failures return 401. Docker inspection/update failures return 500 and
do not mark the delivery as completed, so they can be retried.

## Tests

Run `npm test`. Tests use mocked Docker inspection and restart operations.

## Service manager

Open `https://<webhook-host>/admin` to sign in with one shared password, select an
application service, edit its environment, replicas, CPU/memory limits and restart
policy, then **Save & redeploy**. Image, networks, mounts, secrets, labels and other
settings are preserved. Environment values are hidden until revealed; blank values
are supported, and removing a row removes that variable on save. Multiline values
are preserved. Zero replicas stops a service; zero CPU/memory limits means unlimited.
An accepted update means Swarm has started reconciliation, not that the deployment
has become healthy. Check service tasks/logs after deployment.

### Enable on an existing webhook service

Create two independent secrets on the Swarm manager. Put a strong shared password
(at least 16 characters) into `/secure/path/admin-password` without committing it or
putting it in shell history. Create a random JWT signing key separately:

```bash
openssl rand -hex 32 | docker secret create bfast_admin_jwt -
docker secret create bfast_admin_password /secure/path/admin-password

docker service update \
  --replicas 1 \
  --secret-add bfast_admin_password \
  --secret-add bfast_admin_jwt \
  --env-add ADMIN_PASSWORD_FILE=/run/secrets/bfast_admin_password \
  --env-add ADMIN_JWT_SECRET_FILE=/run/secrets/bfast_admin_jwt \
  --env-add ADMIN_ORIGIN=https://webhook-faas.bfast.smartstock.co.tz \
  --env-add ADMIN_EXCLUDED_SERVICES=webhook \
  --force webhook
```

Deploy this code and install its dependencies before enabling the routes. Existing
Git-mode services fetch the published repository on startup. `ADMIN_ORIGIN` must
match the browser's exact HTTPS origin, without a trailing slash or path. HTTPS is
required; TLS can terminate at Traefik. Missing configuration disables the manager
with HTTP 503 without disabling the GitHub webhook. Invalid configured secrets or
origin fail startup. Secret files are trimmed, so avoid leading/trailing whitespace.

Only replicated application services are shown. The server blocks both listing and
direct access to names containing the `webhook`, `traefik`, `bfast`, or `control`
underscore-delimited components, `bfast.app=bfast`, `bfast.control=true`,
`PROJECT_ID=_BFAST_ADMIN`, services with host bind mounts, manager-only constraints,
and names in comma-separated `ADMIN_EXCLUDED_SERVICES`. Global services are also
excluded. Add `bfast.control=true` to any additional infrastructure service before
exposing this manager. The exclusions cannot be edited through this UI.

The shared password grants administration of all eligible services, including access
to plaintext environment secrets. Only share it with trusted operators. Sessions last
30 minutes, with HS256 JWTs in Secure/HttpOnly/SameSite=Strict host-only cookies,
exact-origin and CSRF checks on writes, no-store responses, and a restrictive CSP.
Tokens never go into browser local storage. Logout revokes the current session.
A global limit of 10 login attempts/minute does not trust forwarded IP headers.
Sessions and limits are held in memory: **run one replica**; restarting the manager
revokes every session. To rotate credentials, attach replacement Docker secrets,
update the secret file paths, and restart the manager. Use edge rate limiting as
well if exposed publicly. Configuration values, passwords and JWTs are not logged.

### Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/admin` | Management page |
| POST | `/admin/api/login` | `{ "password": "…" }`; sets JWT cookie and returns CSRF token |
| GET | `/admin/api/session` | Validate session and retrieve CSRF token |
| POST | `/admin/api/logout` | Revoke session and clear cookie |
| GET | `/admin/api/services` | Eligible service IDs, names and desired replica counts |
| GET | `/admin/api/services/:service` | Current environment, image, settings and version |
| POST | `/admin/api/services/:service` | Save settings and redeploy |

Writes require `Origin: <ADMIN_ORIGIN>`, `Content-Type: application/json`, and,
except login, `X-CSRF-Token` from the session endpoint. Updates accept exactly
`version`, `env` (array of `KEY=value` strings), `replicas`, `cpus`, `memoryMB`, and
`restart` (`any`, `on-failure`, `none`). Use the version returned by GET. The Docker
update includes this version to prevent concurrent changes from being overwritten;
HTTP 409 requires reloading the service. Unknown fields and invalid settings are
rejected. Docker secret contents are never returned by this API.

Security references: [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
and [CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
