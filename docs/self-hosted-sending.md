# Sending mail without Resend

How to make Kwings Mail deliver outgoing mail straight from our own server
(`164.68.97.187`, `mail.kwingsmedia.com`), with no third-party relay and no
daily sending limit.

**How it works:** a small Postfix container runs next to the app. The app hands
it every outgoing message (`SMTP_URL=smtp://postfix:587`); Postfix signs it with
our own DKIM key and delivers it directly to Gmail, Outlook, etc. on port 25.
Postfix is only reachable from inside Docker, never from the internet.

Checked on the server (Oct 2026):

- Outbound port 25 is **open** (Gmail, Outlook, Yahoo, iCloud all answer).
- `164.68.97.187` is **not** on Spamhaus, SpamCop, Barracuda, SORBS or PSBL.
- The app's Docker network is `kwings-mail_default` (`192.168.16.0/20`).

Total time: about 30 minutes, plus DNS propagation.

---

## 1. Set reverse DNS (Contabo panel)

Gmail and Outlook distrust servers whose IP does not resolve back to their name.

1. Contabo Customer Control Panel → **Reverse DNS management**.
2. Edit `164.68.97.187` → set to `mail.kwingsmedia.com` → save.
3. Check (can take up to an hour):

   ```bash
   dig +short -x 164.68.97.187
   # expected: mail.kwingsmedia.com.
   ```

Do not continue until this returns `mail.kwingsmedia.com.`

---

## 2. Add Postfix to the compose file

Edit **both** copies so the next CI deploy does not lose it:

- in the repo: `deploy/server/docker-compose.prod.yml`
- on the server: `/opt/kwings-mail/docker-compose.prod.yml`

```yaml
# Production on the VPS (/opt/kwings-mail). Driven by deploy.sh; settings come from .env next to this file.
# Web is published on 127.0.0.1 only (host Nginx serves mail.kwingsmedia.com); SMTP 25 is public for inbound mail.
name: kwings-mail

services:
  mailflare:
    image: ghcr.io/rukshan2000/kwings-mail:${IMAGE_TAG:?set IMAGE_TAG}
    restart: unless-stopped
    ports:
      - "127.0.0.1:3030:3000"
      - "25:25"
    env_file: .env
    volumes:
      - data:/data
    depends_on:
      - postfix

  # Outbound only: no ports published, reachable as postfix:587 from the app.
  postfix:
    image: boky/postfix:latest   # pin a release tag from github.com/bokysan/docker-postfix/releases
    restart: unless-stopped
    hostname: mail.kwingsmedia.com
    environment:
      ALLOWED_SENDER_DOMAINS: kwingsmedia.com
      DKIM_AUTOGENERATE: "true"
      DKIM_SELECTOR: mail
      POSTFIX_myhostname: mail.kwingsmedia.com
      POSTFIX_inet_protocols: ipv4      # reverse DNS is set for IPv4 only
      POSTFIX_message_size_limit: "37748736"
    volumes:
      - dkim:/etc/opendkim/keys         # keep the DKIM key across restarts
      - spool:/var/spool/postfix        # keep queued mail across restarts

volumes:
  data:
  dkim:
  spool:
```

Copy the repo version to the server (from the `mailflare` folder on your Mac):

```bash
scp deploy/server/docker-compose.prod.yml root@164.68.97.187:/opt/kwings-mail/
ssh root@164.68.97.187 'chown gh-runner:gh-runner /opt/kwings-mail/docker-compose.prod.yml'
```

---

## 3. Start Postfix and get the DKIM key

```bash
ssh root@164.68.97.187
cd /opt/kwings-mail
export IMAGE_TAG=$(tail -1 .deploy-history)

docker compose -f docker-compose.prod.yml up -d postfix
docker compose -f docker-compose.prod.yml logs postfix | tail -20

# The DNS record to publish:
docker compose -f docker-compose.prod.yml exec postfix cat /etc/opendkim/keys/kwingsmedia.com.txt
```

The output looks like:

```
mail._domainkey IN TXT ( "v=DKIM1; h=sha256; k=rsa; "
    "p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..." )
```

Join the quoted parts into one value (no quotes, no spaces between parts):

```
v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
```

---

## 4. Update DNS (Namecheap → Advanced DNS)

| Action | Type | Host | Value |
|---|---|---|---|
| **Add** | TXT | `mail._domainkey` | the joined value from step 3 |
| **Keep** | TXT | `@` | `v=spf1 a:mail.kwingsmedia.com ~all` (already covers our IP) |
| **Keep** | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:rukshan@kwingsmedia.com` (add the `rua` part to get reports) |
| **Keep** | MX | `@` | `mail.kwingsmedia.com` priority 10 |

Do **not** delete the Resend records yet (see step 7).

Check the DKIM record is live:

```bash
dig +short TXT mail._domainkey.kwingsmedia.com
```

---

## 5. Point the app at Postfix

On the server, edit `/opt/kwings-mail/.env`:

```bash
nano /opt/kwings-mail/.env
```

Replace the Resend line:

```diff
- SMTP_URL=smtps://resend:re_xxx@smtp.resend.com:465
+ SMTP_URL=smtp://postfix:587
```

Restart the app:

```bash
cd /opt/kwings-mail
IMAGE_TAG=$(tail -1 .deploy-history) docker compose -f docker-compose.prod.yml up -d
```

---

## 6. Test

1. Go to **https://www.mail-tester.com**, copy the address it shows, send it a
   real email (subject + a few sentences + signature) from Kwings Mail, then
   click "Then check your score". Aim for **9/10 or better**. It tells you
   exactly what is wrong if not.
2. Send to a Gmail address, open it → **⋮ → Show original**. All three must say
   **PASS**: SPF, DKIM, DMARC.
3. Send to an Outlook/Hotmail address too (Microsoft is the strictest).

Watch delivery live while testing:

```bash
docker compose -f /opt/kwings-mail/docker-compose.prod.yml logs -f postfix
# status=sent       -> delivered
# status=deferred   -> will retry; read the reason
# status=bounced    -> rejected; read the reason
```

---

## 7. Remove Resend (after ~1 week of clean delivery)

1. Namecheap: delete `resend._domainkey` (TXT), `send` (CNAME), `rsend` (CNAME).
2. Resend dashboard: delete the API key, then the domain.
3. Nothing else: the app no longer references Resend.

---

## Rollback (anytime)

Put the Resend line back in `/opt/kwings-mail/.env` and restart:

```bash
cd /opt/kwings-mail
IMAGE_TAG=$(tail -1 .deploy-history) docker compose -f docker-compose.prod.yml up -d
```

Works as long as you have not done step 7.

---

## Day-to-day operations

| Task | Command (in `/opt/kwings-mail`) |
|---|---|
| See queued/stuck mail | `docker compose -f docker-compose.prod.yml exec postfix postqueue -p` |
| Retry the queue now | `docker compose -f docker-compose.prod.yml exec postfix postqueue -f` |
| Delivery log | `docker compose -f docker-compose.prod.yml logs --since 1h postfix` |
| Blocklist check | https://mxtoolbox.com/blacklists.aspx → `164.68.97.187` |

Postfix retries deferred mail automatically for up to 5 days.

## Keeping mail out of spam

- **Warm up the IP.** First 2 weeks: real mail only, a few dozen a day. No bulk sends, no newsletters.
- **Sign up for Google Postmaster Tools** (postmaster.google.com) and add `kwingsmedia.com` to see Gmail's view of our reputation.
- **Microsoft:** if Outlook rejects or junks our mail, register the IP at
  https://sendersupport.olc.protection.outlook.com/snds/ and request delisting
  via https://sender.office.com if needed.
- **Tighten DMARC** after a month of passing reports: `v=DMARC1; p=quarantine; rua=mailto:rukshan@kwingsmedia.com`.
- **Protect the IP.** It is shared with every other app on this server. If any
  of them is compromised and sends spam, the IP gets blocklisted and company
  mail suffers. Check the blocklist link above monthly.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| App says sent, nothing arrives, log shows `Connection timed out` to port 25 | Provider blocking outbound 25 | Ask Contabo support to unblock port 25 |
| Gmail: `550-5.7.25 ... PTR record` | Reverse DNS not set | Step 1 |
| Gmail "Show original": DKIM `FAIL` / `neutral` | DNS value pasted wrongly | Re-join the key from step 3, no quotes or line breaks |
| Outlook: `550 5.7.1 ... blocked using Spamhaus` or `S3150` | IP reputation | Blocklist check; Microsoft delisting form above |
| Log: `Sender address rejected: not owned` | Sending from a domain not in `ALLOWED_SENDER_DOMAINS` | Add it (space-separated) and restart Postfix |
