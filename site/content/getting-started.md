# Getting started

BFast Cloud runs your Node.js functions on a managed Docker Swarm. You write
functions with **bfast-functions**, run them locally with **bfast-tools**, push to
GitHub, and every push to your default branch redeploys the service over HTTPS.

## 1. Install the CLI

You need Node.js 18 or newer.

```bash
npm install -g bfast-tools
bfast --version
```

## 2. Create a workspace

```bash
bfast fs create my-functions
cd my-functions
```

The workspace contains `bfast.json`, `package.json` and a `functions/` folder.
Every exported object in `functions/` with an `onRequest`, `onEvent`, `onGuard` or
`onJob` handler becomes part of your service.

## 3. Write a function

```js
// functions/index.mjs
export const hello = {
  method: 'get',
  path: '/hello',
  description: 'Say hello',
  onRequest: (req, res) => res.json({message: `Hello ${req.query.name ?? 'world'}`})
};

export const nightly = {
  rule: '0 2 * * *',
  onJob: () => console.log('nightly clean-up')
};
```

See the [function specification](/docs/function-spec) for HTTP routes, Socket.IO
events, guards and scheduled jobs.

## 4. Run it locally

```bash
bfast fs serve --port 3000
curl http://localhost:3000/hello?name=Asha
curl http://localhost:3000/functions-health
```

`/functions-all` lists every function your service exposes.

## 5. Push to GitHub

Commit the workspace to a GitHub repository. Dependencies in `package.json` are
installed when the service starts.

```bash
git init && git add . && git commit -m "First functions"
git remote add origin https://github.com/you/my-functions.git
git push -u origin main
```

## 6. Deploy on BFast Cloud

1. Sign in to the [console](/admin) with Google.
2. During early access an administrator creates your service with `MODE=git` and
   your repository's `GIT_CLONE_URL`. It gets HTTPS hostnames such as
   `my-functions-faas.<cluster>.<domain>`. Self-service sign-up is on the way.
3. Open the service's **Auto-deploy** tab and copy the payload URL and secret into
   your repository under **Settings → Webhooks** (content type `application/json`,
   push events).

From now on every push to the default branch rolls out a fresh copy of your
functions. Use the console to edit environment variables, attach secrets, read
logs, restart, archive and unarchive the service.

## Where next

- [Environment variables](/docs/environment-variables) understood by the runtime
- [Security & operations](/docs/security-and-ops)
- [Console, webhooks & access](/docs/cloud) for operators
