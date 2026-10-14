# Deployment runbook — production server

Live deployment of this app on the shared Ubuntu host `207.249.229.236`
(other sites run here: chat/code/dash .webuilder.dev — don't touch their
configs). Deployed from git tag/commit **M4** (`4951c95`).

## What's deployed where

| Thing | Value |
| --- | --- |
| Public URL | `https://ai-voice-agent.webuilder.dev` |
| Compose project | `ai-voice-agent` (run from the repo dir) |
| Containers | `ai-voice-agent-app-1` (app, loopback only), `ai-voice-agent-postgres-1` (postgres:16-alpine, no host port) |
| Data volume | `ai-voice-agent_pgdata` — **never delete** |
| App repo on server | `/var/www/code.webuilder.dev/ai-voice-agent` |
| Env / secrets | `/var/www/code.webuilder.dev/ai-voice-agent/.env` (mode 600, gitignored; admin password + retention salt live only here) |
| Nginx site | `/etc/nginx/sites-available/ai-voice-agent.webuilder.dev` (symlinked into `sites-enabled/`) |
| WS map | `/etc/nginx/conf.d/ai-voice-agent-websocket-map.conf` (`$aiva_connection_upgrade` — unique name to avoid colliding with the map in the code.webuilder.dev site file) |
| TLS cert | `/etc/letsencrypt/live/ai-voice-agent.webuilder.dev/` (Let's Encrypt, ECDSA, auto-renews) |
| App port | `127.0.0.1:3000` only — nginx is the only public entry |

## Quick status

```bash
docker compose ps                 # both services "healthy"
curl -s http://127.0.0.1:3000/health
curl -s https://ai-voice-agent.webuilder.dev/health
docker compose logs -f app        # app logs (pino JSON)
```

## Using the app

- **Admin console**: `https://ai-voice-agent.webuilder.dev/admin` — basic auth;
  user/password are in `.env` on the server (`ADMIN_USER` / `ADMIN_PASSWORD`).
  The settings UI lets you edit runtime config live: retention, consent,
  escalation, skills toggles, `devBrowserCalls`, `twilio.mediaWsPath`.
  **Restart required** after changing: `skills.dir`, `skills.enabled` (skill
  manifests load once at startup), and `twilio.mediaWsPath` (route is
  registered at boot).
- **Twilio webhooks** (configure on the Twilio number):
  - Voice webhook (HTTP POST): `https://ai-voice-agent.webuilder.dev/twiml`
  - Media stream (from the TwiML `<Connect><Stream>`): `wss://ai-voice-agent.webuilder.dev/media/twilio`
  - `/twiml` validates the Twilio signature using the full request URL, so
    Twilio must reach it through nginx on the public hostname (it does).
    No extra header allowlist is needed; nginx forwards `Host`.

## Environment (`.env` on the server)

| Var | Value / status |
| --- | --- |
| `PORT` | `3000` |
| `PUBLIC_BASE_URL` | `https://ai-voice-agent.webuilder.dev` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / generated (29 chars, in `.env`) |
| `RETENTION_HASH_SALT` | generated (64 hex chars, in `.env`) |
| `CONSENT_ENABLED` | `true` |
| `RETENTION_ENABLED` / `RETENTION_DAYS` | `true` / `90` |
| `DEV_BROWSER_CALLS` | `false` — flip to `true` **temporarily** for browser-harness smoke tests (`docker compose up -d` to apply), then back to `false`; it exposes `/dev/call` + `/media/browser` publicly |
| `ELEVENLABS_API_KEY` | **OPERATOR TODO** — empty = calls run without TTS (degraded) |
| `OPENROUTER_API_KEY` | **OPERATOR TODO** — empty = no LLM replies |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | **OPERATOR TODO** — empty ⇒ `/twiml` answers `503` (fail-closed) |
| `ESCALATION_STAFF_NUMBER` | **OPERATOR TODO** — empty ⇒ escalation announces + ends the call instead of dialing staff |
| `SKILLS_HTTP_BOOKING_URL` | empty; keep `SKILLS_HTTP_BOOKING_METHOD`/`_TIMEOUT_MS` **commented out** while the URL is empty — the loader drops empty strings and a booking record without `url` is a fatal boot error |

After editing `.env`: `docker compose up -d` (recreates the container; env is
read at container creation, not per restart-loop iteration).

## Update procedure

```bash
cd /var/www/code.webuilder.dev/ai-voice-agent
git pull
docker compose up -d --build
```

Migrations run in-container before the server starts
(`node dist/db/migrate-cli.js && node dist/server.js`); check
`docker compose logs app | grep migrate` after updating.

## TLS renewal

Certbot's scheduled task renews automatically (cert expires 2027-01-12).
Force a dry run / renewal:

```bash
certbot renew --dry-run
certbot renew --force-renewal --nginx -d ai-voice-agent.webuilder.dev
nginx -t && systemctl reload nginx   # after any manual nginx edit — reload, never restart
```

## Backups

The volume `ai-voice-agent_pgdata` holds all state. Preferred backup
(consistent, no downtime):

```bash
docker compose exec -T postgres pg_dump -U voice voice | gzip > ~/voice-$(date +%F).sql.gz
# restore: gunzip -c file.sql.gz | docker compose exec -T postgres psql -U voice -d voice
```

A filesystem snapshot of the volume while postgres is running is NOT
guaranteed consistent — prefer `pg_dump`.

## Production checklist

- [x] Consent notice enabled (`CONSENT_ENABLED=true`)
- [x] Retention enabled + `RETENTION_HASH_SALT` set (startup purge ran with 0 rows)
- [x] DB clean at go-live (test rows truncated; `settings` table empty)
- [x] TLS valid, HTTP→HTTPS redirect, WS upgrade verified through nginx (101)
- [x] Admin console auth working
- [x] App port bound to 127.0.0.1 only; postgres has no host port
- [ ] `ELEVENLABS_API_KEY` (TTS)
- [ ] `OPENROUTER_API_KEY` (LLM)
- [ ] `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` (enables `/twiml` signature check)
- [ ] `ESCALATION_STAFF_NUMBER`
- [ ] Point the Twilio number's voice webhook at `/twiml` (URLs above)
