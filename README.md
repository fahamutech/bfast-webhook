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
  --label 'traefik.http.routers.webhook.rule=Host(`webhook-faas.bfast.<bfast-cloud-host-domain>`)' \
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

A 403 response now means the URL names a different service, the target is not
in Git mode, or its `GIT_CLONE_URL` does not match the sending repository. Correct
the webhook URL or target service configuration, then redeliver the failed event.
Signature failures return 401. Docker inspection/update failures return 500 and
do not mark the delivery as completed, so they can be retried.

## Tests

Run `npm test`. Tests use mocked Docker inspection and restart operations.
