# bfast-webhook

GitHub push webhook for BFast Cloud. Deploy this public repository as a FaaS
service named `webhook`. A signed push to the repository's default branch can restart only the Swarm
service mapped to that GitHub repository. The target service name comes from the
webhook URL: `/github-webhook/<service>`.

## Why `START_SCRIPT` is required

`functions/index.mjs` exports the BFast function descriptor. The shared
`bfast-function` runtime parses JSON before invoking descriptors, which removes
the exact request bytes GitHub signs. `START_SCRIPT=node server.mjs` starts a
small raw HTTP server that routes to the same descriptor handler, allowing exact
SHA-256 signature verification without changing the shared runtime image.

## Create the Swarm service

Create a random secret in a file outside this public repository, then add it as
a Docker secret using the same value entered in GitHub's webhook settings:

```bash
docker secret create github_webhook_secret /secure/path/github-webhook-secret
```

Run this on a Swarm manager after the repository is public. Replace the example
repository-to-service mapping with the actual source repository and service:

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
  --env 'START_SCRIPT=node server.mjs' \
  --env WEBHOOK_SECRET_FILE=/run/secrets/github_webhook_secret \
  --env 'WEBHOOK_TARGETS_JSON={"fahamutech/example-functions":"example_faas"}' \
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

The source repository must be listed in `WEBHOOK_TARGETS_JSON` with the same
service name as the URL. The receiver reads `repository.default_branch` from
GitHub's signed payload, so pushes to `main`, `master`, or any other default
branch name trigger an update automatically. Pushes to other branches and branch
deletions are ignored. For a `MODE=git` function service, the new task clones the
repository's default branch on startup.
