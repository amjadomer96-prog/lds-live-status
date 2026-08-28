# LDS Live Studio — status service

Small Vercel function that watches your Figma files and publishes a public
JSON status. The Figma token stays on the server; the response never contains it.

---

## 1. Get a Figma token

Figma → your avatar → **Settings** → **Security** → **Personal access tokens** →
**Generate new token**. Scope: *File content — read only* is enough.

Copy it now; Figma won't show it again.

## 2. Deploy

Put this folder in a Git repo and import it on Vercel (**Add New → Project**),
or run `npx vercel` from inside it.

## 3. Add two environment variables

Vercel → your project → **Settings** → **Environment Variables**.

**`FIGMA_TOKEN`** — the token from step 1.

**`LIVE_STUDIO_CONFIG`** — one entry per designer, as JSON on a single line:

```json
[{"name":"Arham","role":"Product Designer","fileKey":"UF8I8EFNfremnn8Db8Vbor"},{"name":"Sana","role":"Product Designer","fileKey":"PUT_SECOND_FILE_KEY_HERE"}]
```

The **fileKey** is the part of a Figma URL after `/design/`:
`figma.com/design/`**`UF8I8EFNfremnn8Db8Vbor`**`/App-Design`

Optional: **`LIVE_WINDOW_MINUTES`** (default `10`) — minutes of no edits before
the studio flips to offline.

Redeploy after adding variables.

## 4. Point Framer at it

Open `/live`, select **LiveStudio**, paste your URL into **Status URL**:

```
https://your-project.vercel.app/api/status
```

Do the same on the Home page for **LiveStudioPreview**. Publish.

That's it. Both pages now follow Figma automatically.

---

## What it does

Every 30 seconds (edge-cached, so Figma is polled at most twice a minute) it:

1. Reads each configured file with `GET /v1/files/:key?depth=1` — cheap, returns
   the file name and page names only
2. Marks a designer **live** if `lastModified` is inside the live window
3. Pulls version history for live files and turns it into activity lines
4. Estimates session start from the oldest edit in the current run

## Behaviour worth knowing

**"Live" means recently edited, not present.** Figma has no presence API — there
is no way to ask whether someone is sitting in a file. Everything here is
inferred from edit timestamps.

**`lastModified` can lag.** Figma ties it to version checkpoints rather than
every keystroke, so the studio may show live a few minutes after work starts and
stay live a few minutes after it stops. Widen or narrow `LIVE_WINDOW_MINUTES` to
taste.

**Any file you list becomes publicly visible** through the embed on `/live`. Only
list files that are safe to show the whole internet.

**Framer's fields are the fallback.** Clear **Status URL** and the components go
back to using the values typed into Framer. If the endpoint is unreachable, the
last good payload is kept rather than blanking the page.

## Not built yet

**Which screen they're working on.** The component already accepts a
`focusNodeId` and deep-links the embed to that frame — but the REST API exposes
no per-node modified time, so nothing sets it. Detecting it needs snapshot
diffing between polls, which needs storage (Vercel KV or Supabase). That's a
second pass.

**Webhooks instead of polling.** `FILE_UPDATE` would remove the lag entirely.
Figma documents webhook limits from Professional upward, so it needs a paid plan.
