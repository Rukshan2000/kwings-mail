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
      POSTFIX_smtp_tls_security_level: may        # encrypt delivery whenever the receiver supports it
      POSTFIX_smtp_tls_loglevel: "1"              # log whether each delivery used TLS
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

## Anti-spam: keeping OUR mail out of spam folders

Receivers decide "inbox or spam" from three things: **authentication** (can
they prove it is really us), **reputation** (has this IP/domain behaved well),
and **content**. Work through these in order.

### A. Authentication (must all pass)

| Check | Record / setting | Status after steps 1–5 |
|---|---|---|
| Reverse DNS (PTR) | `164.68.97.187` → `mail.kwingsmedia.com` | Step 1 |
| Forward DNS matches | `mail.kwingsmedia.com` A → `164.68.97.187` | ✅ already set |
| HELO name | Postfix greets as `mail.kwingsmedia.com` | ✅ `POSTFIX_myhostname` |
| SPF | `@` TXT `v=spf1 a:mail.kwingsmedia.com ~all` | ✅ already set |
| DKIM | `mail._domainkey` TXT | Step 4 |
| DMARC | `_dmarc` TXT | ✅ set, tighten below |
| TLS on delivery | `smtp_tls_security_level=may` | ✅ in compose |

PTR, A record and HELO must all say the same name (`mail.kwingsmedia.com`).
Gmail calls this "forward-confirmed reverse DNS"; without it, mail is
rejected with `550-5.7.25`.

Check the DKIM key is 2048-bit (1024-bit keys are treated as weak):

```bash
dig +short TXT mail._domainkey.kwingsmedia.com | tr -d '" ' | sed 's/.*p=//' | base64 -d 2>/dev/null | wc -c
# about 294 = 2048-bit (good), about 162 = 1024-bit (regenerate)
```

### B. Tighten SPF and DMARC over time

Strict policies tell receivers "anything failing these checks is forged",
which both protects our name and earns more trust.

| When | SPF (`@` TXT) | DMARC (`_dmarc` TXT) |
|---|---|---|
| Now | `v=spf1 a:mail.kwingsmedia.com ~all` | `v=DMARC1; p=none; rua=mailto:rukshan@kwingsmedia.com` |
| After 2 weeks of PASS in reports | `v=spf1 a:mail.kwingsmedia.com -all` | `v=DMARC1; p=quarantine; pct=100; rua=mailto:rukshan@kwingsmedia.com` |
| After 1 month clean | (same) | `v=DMARC1; p=reject; rua=mailto:rukshan@kwingsmedia.com` |

The `rua` address receives daily XML reports from Gmail, Outlook, etc. listing
every IP that sent as `kwingsmedia.com` and whether it passed. Paste them into
a free viewer (e.g. dmarcian.com XML-to-human converter) to read them. Only
move to the next row when the reports show our IP passing and nothing
legitimate failing.

If you add another service that sends as `@kwingsmedia.com` (a newsletter
tool, a website contact form, Google Workspace…), add it to SPF **before**
tightening, or its mail will be rejected.

### C. Optional extras that raise trust

- **MTA-STS + TLS-RPT**: tells other servers to always use TLS with us.
  1. Add DNS TXT `_mta-sts` → `v=STSv1; id=20261021`
  2. Add DNS TXT `_smtp._tls` → `v=TLSRPTv1; rua=mailto:rukshan@kwingsmedia.com`
  3. Serve `https://mta-sts.kwingsmedia.com/.well-known/mta-sts.txt` (new nginx
     vhost via `/root/scripts/add-subdomain.sh`) containing:
     ```
     version: STSv1
     mode: testing
     mx: mail.kwingsmedia.com
     max_age: 86400
     ```
     Switch `mode` to `enforce` once inbound STARTTLS is enabled (see below).
- **BIMI** (logo next to our mail in Gmail): needs DMARC at `quarantine` or
  `reject` and, for Gmail, a paid VMC certificate. Skip unless brand matters.

### D. Reputation

- **Warm up the IP.** Weeks 1–2: real person-to-person mail only, up to a few
  dozen a day. Weeks 3–4: up to ~100/day. Never start with a bulk send.
- **Get replies.** Replies and "Not spam" clicks are the strongest positive
  signals. Ask early recipients to add us to contacts.
- **Never buy or scrape lists.** Hitting old/invalid addresses (bounces) and
  spam traps destroys reputation fast. Remove any address that hard-bounces.
- **Newsletters go elsewhere.** Keep marketing/bulk mail off this IP and domain;
  use a dedicated service on a subdomain (e.g. `news.kwingsmedia.com`) so a
  complaint spike never hurts company mail.
- **Monitor:**
  - Google Postmaster Tools (postmaster.google.com): add `kwingsmedia.com`;
    shows spam rate and domain reputation. Keep spam rate **below 0.1%**.
  - Microsoft SNDS (https://sendersupport.olc.protection.outlook.com/snds/):
    register `164.68.97.187`. If Outlook blocks us, request delisting at
    https://sender.office.com.
  - Blocklists monthly: https://mxtoolbox.com/blacklists.aspx → `164.68.97.187`.

### E. Content

- A real subject, a few sentences, a plain signature. No one-word "test" mails.
- Avoid all-caps, `!!!`, "FREE", "URGENT", "click here", and link shorteners.
- Link text should match the link (`kwingsmedia.com` linking to kwingsmedia.com).
- Prefer few images; never an image-only email.
- Attachments: PDFs and images are fine; never `.zip`, `.exe`, `.js`, macro
  Office files (`.docm`, `.xlsm`).

### F. Stop the server itself becoming a spam source

A spam outbreak from **any** source on `164.68.97.187` gets the IP blocklisted
and company mail stops being delivered.

- **Accounts are the main risk.** A staff account with a stolen password can
  send thousands of spam mails through us. For every account: a long unique
  password, and **two-factor authentication** (Settings → Security). Delete
  accounts of people who leave.
- **Watch for spikes.** A sudden jump in the Postfix log is the first sign of a
  compromised account:
  ```bash
  docker compose -f /opt/kwings-mail/docker-compose.prod.yml logs --since 24h postfix | grep -c "status=sent"
  ```
  Normal is your usual daily count. If it explodes, disable the account in
  Admin → Accounts and flush the queue
  (`docker compose -f docker-compose.prod.yml exec postfix postsuper -d ALL deferred`).
- **Other apps on this server** must not send mail directly from this IP.
  - Programs running on the host itself: block them with
    ```bash
    ufw deny out 25/tcp comment 'only the kwings-mail postfix container sends mail'
    ```
    This rule does **not** apply to Docker containers (their traffic bypasses
    ufw's outbound rules), so our Postfix keeps working, but neither does it
    stop the other ~25 Docker projects here.
  - Docker projects: check none of them sends on port 25, and configure any
    that need email to use their own provider (Resend, SES) on port 465/587.
    Quick audit of who is talking to port 25 right now:
    ```bash
    conntrack -L -p tcp --dport 25 2>/dev/null | awk '{print $5}' | sort | uniq -c
    ```
- **Postfix is not exposed.** It has no published port, so outsiders cannot
  use it as an open relay. Keep it that way: never add `ports:` to the
  `postfix` service.

---

## Anti-spam: protecting OUR inbox from incoming spam

### What already works

- **Built-in spam filter** (Settings → Inbox → Spam protection, on by
  default). Scores every incoming message 0–100 from content, sender history,
  links and attachments; 70+ goes to Spam. Nothing is sent to outside services.
- **It learns from you.** Use **Report spam** on junk and **Not spam** on
  false positives. Learning is per mailbox, so each person should train their
  own inbox, especially in the first weeks.
- **Sender blocking**: block persistent senders from the message menu.

### The gap on this server

The built-in filter only trusts authentication results stamped by Cloudflare
(`src/lib/spam/analyzers/authentication.ts`). Our server receives mail
directly on port 25, and nothing on that path verifies the sender's SPF, DKIM
or DMARC, or checks the sending IP against blocklists. So:

- forged mail claiming to be from `@kwingsmedia.com` or from a bank is judged
  on content only;
- known spam IPs on Spamhaus are not rejected at the door.

Ways to close it, simplest first:

1. **Code change in the app (recommended).** Verify SPF/DKIM/DMARC and check
   Spamhaus in the SMTP listener (`server/runtime/smtp.ts`), and let the spam
   filter trust results stamped by our own server. Self-contained, no new
   containers. Ask Claude Code to implement it.
2. **A filtering gateway in front of the app.** Run Postfix (with postscreen
   and DNS blocklists) plus Rspamd as the public MX on port 25, and have it
   pass clean mail to the app on an internal port. Most powerful, but a much
   bigger setup to run and update.
3. **Cloudflare Email Routing relay** (`deploy/cloudflare-email-relay`):
   Cloudflare filters and authenticates, then forwards to the app. Requires
   moving the domain's DNS from Namecheap to Cloudflare.

### Also recommended

- **Turn on STARTTLS for incoming mail** so mail sent to us is encrypted in
  transit (some senders, e.g. banks, require it). The app supports it via
  `SMTP_TLS_KEY` / `SMTP_TLS_CERT`; it needs the Let's Encrypt certificate for
  `mail.kwingsmedia.com` copied somewhere the container can read, renewed by
  a certbot deploy hook. Ask Claude Code to set it up.
- **Don't publish addresses as plain text** on the website. Use a contact form
  or write them as `info [at] kwingsmedia.com` to cut scraper spam.
- **Keep a catch-all off.** Only real mailboxes and aliases should accept mail;
  a catch-all receives every dictionary-attack address spammers try.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| App says sent, nothing arrives, log shows `Connection timed out` to port 25 | Provider blocking outbound 25 | Ask Contabo support to unblock port 25 |
| Gmail: `550-5.7.25 ... PTR record` | Reverse DNS not set | Step 1 |
| Gmail "Show original": DKIM `FAIL` / `neutral` | DNS value pasted wrongly | Re-join the key from step 3, no quotes or line breaks |
| Outlook: `550 5.7.1 ... blocked using Spamhaus` or `S3150` | IP reputation | Blocklist check; Microsoft delisting form above |
| Log: `Sender address rejected: not owned` | Sending from a domain not in `ALLOWED_SENDER_DOMAINS` | Add it (space-separated) and restart Postfix |
