# Putting it online

The repository is already on GitHub
([Ahmed-Ragab0/Organophile](https://github.com/Ahmed-Ragab0/Organophile)), and
`main` is what deploys. Nothing here changes how the app works locally.

---

## 1. Which platform, and why

**Vercel.** Not by default — by fit:

| | |
|---|---|
| **Vercel** ✅ | Next.js is theirs. `src/proxy.ts` (Next 16's middleware) runs at the edge with no adapter, and the App Router, streaming and image optimisation work untouched. Free tier covers this app comfortably. |
| Cloudflare Workers | Cheap and fast, but Next needs an adapter (`@opennextjs/cloudflare`) and the middleware/runtime story is a moving target. A build that breaks on someone else's release schedule is not worth the saving here. |
| Netlify | Works, via their Next runtime. Always a step behind on Next releases — and this app is on 16.3. |
| A VPS (Hetzner/DigitalOcean) | Full control, and you now own Node upgrades, TLS renewal, restarts and uptime. There is nothing in this app that needs a server you administer. |

The deciding fact is that **the data does not live in the web app.** Supabase
holds the database, auth, the webhooks and the payout sync. The Next app is a
client with a thin server layer, so the host only has to serve it — and the one
thing it must get right, middleware, is the thing Vercel gets right for free.

**Region.** The Supabase project is in **West EU (Ireland)**. Set Vercel's
function region to **Dublin (`dub1`)** so the server-side auth check is a
same-city hop rather than a transatlantic one. Vercel → Settings → Functions →
Region.

---

## 2. First deploy

**Import.** Vercel → Add New → Project → import `Ahmed-Ragab0/Organophile`.

**Root Directory: `web`.** This is the one setting that is not the default and
the one that breaks the build if it is missed — the repository root holds
`supabase/` and `docs/` as well, and the Next app is one level down. Everything
else (framework, build command, output) is detected.

> **`404: NOT_FOUND` on every path is what missing that looks like.** There is
> no `package.json` at the repository root, so Vercel finds no framework, builds
> nothing, and serves an empty deployment — the domain resolves, the edge
> answers (`fra1::…`), and there is simply nothing behind it. It is a Vercel
> page, not one of ours: our own 404 is in Arabic with the sidebar around it.
>
> Fix it in **Settings → Build and Deployment → Root Directory → `web`**, then
> **Deployments → ⋯ → Redeploy**. Changing the setting alone does not rebuild.
>
> If the Root Directory is already `web`, check in this order:
> 1. **Deployments** — is there a *Ready* deployment marked **Production**? A
>    failed build leaves the domain pointing at nothing.
> 2. **Settings → Domains** — is the domain on *this* project, and assigned to
>    the production branch rather than a preview?
> 3. **Settings → Git** — is the production branch `main`?

**Environment variables** — two, and only two:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://egaaigoplqinjvwtnhoo.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API → `anon` `public` |

Add both to **Production, Preview and Development**.

**Node version.** Leave Vercel's default (22.x). The repository has an `.nvmrc`
pinning 20.10.0, but it sits at the root while the Root Directory is `web`, so
Vercel will not read it — and both versions satisfy Next 16. Only set it
explicitly if a build ever disagrees.

> **The service role key never goes here.** It bypasses row-level security
> entirely, and `NEXT_PUBLIC_` variables are compiled into the JavaScript the
> browser downloads. It belongs in Edge Function secrets and in Vault, which is
> where it already is. `web/.env.example` says so in the file itself.

The anon key *is* meant to be public. What protects the data is RLS plus
`app.is_admin()`, and 0037 closed the last thing RLS could not govern.

---

## 3. Two things to do after the first deploy

Both are easy to forget and both fail quietly.

### Sign-in will not work until Supabase knows the URL

Supabase → Authentication → URL Configuration:

- **Site URL** → `https://<your-domain>`
- **Redirect URLs** → add both:
  - `https://<your-domain>/**`
  - `https://<project>-*.vercel.app/**` — the preview deployments, or every
    branch build is a login you cannot complete.

### "تحديث من كاشير" will fail until the origin is allowed

`kashier-sync-payouts` reflects CORS from an allowlist, never `*`, because the
request carries an admin's bearer token. Localhost is always allowed; anything
else has to be named.

Supabase → Edge Functions → Secrets:

```
DASHBOARD_ORIGINS = https://<your-domain>,https://<project>.vercel.app
```

Comma-separated, **no trailing slash**. The symptom when it is missing is
`TypeError: Failed to fetch` with nothing in the function logs — the browser
discards the exchange at the preflight, so the request never reaches Supabase.

---

## 4. Your own domain

**Add it.** Vercel → Project → Settings → Domains → add `organophile.com` (or
`app.organophile.com`). Vercel then shows the exact DNS records to create —
**use the ones it shows you**, not the ones written here, because they change.
At the time of writing they are:

| Record | Host | Value |
|---|---|---|
| `CNAME` | `app` (a subdomain) | `cname.vercel-dns.com` |
| `A` | `@` (the apex) | `76.76.21.21` |

**Where to put them.** Wherever the domain's nameservers point — the registrar
(Namecheap, GoDaddy) or Cloudflare if you moved it there. If you use
Cloudflare's proxy (the orange cloud), set the record to **DNS only** for the
apex; proxying in front of Vercel gives you two CDNs arguing about caching.

**A subdomain is the easier choice.** `app.organophile.com` is a single CNAME,
propagates in minutes, and leaves the apex free for a landing page later.

**TLS** is issued automatically once DNS resolves, usually within a few minutes.

**Then go back to §3.** A new domain is a new Site URL and a new
`DASHBOARD_ORIGINS`. Sign-in and the sync button both break on the new domain
until you do, and neither says why.

---

## 5. What deploying does *not* touch

Worth knowing, so nothing gets moved that should not be:

- **The database, auth, webhooks, Edge Functions and the cron all stay on
  Supabase.** Vercel serves the dashboard and nothing else.
- **Kashier and ukkera keep pointing at Supabase.** Their webhook URLs are
  `…supabase.co/functions/v1/…` and have nothing to do with the web domain.
- **`app.sync_kashier_payouts()` calls the Supabase function URL directly**, so
  the 15-minute cron is unaffected by any of this.

---

## 6. Before you push the button

`.github/workflows/ci.yml` already runs on every push to `main`: `deno fmt
--check`, lint, typecheck and the signature tests for the Edge Functions; the
golden vectors regenerated from the real npm packages and diffed; `npm run lint`
and `npm run build` for the dashboard against placeholder env values; and a
secret scan.

Vercel builds `main` on every push too, and it does **not** wait for CI. So a
push with a red build is a broken production deploy — run the same checks before
pushing rather than after:

```bash
cd supabase && deno fmt --check functions/ tests/ && deno lint functions/ && deno test --allow-all
cd ../web && npm run lint && npm run build
```

`deno fmt --check` is the one that catches people: code that type-checks and
lints cleanly can still fail it, and it is the first job in the workflow.

**Check the repository is private** unless you mean it to be public. Nothing
secret is committed — `.secrets/`, `.backups/` and every `.env` are gitignored,
and the only tracked env file is `web/.env.example` with an empty key — but the
migrations describe the whole financial model, and that is not something to
publish by accident.
