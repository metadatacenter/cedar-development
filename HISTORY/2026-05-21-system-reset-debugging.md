# `cedarat system-reset` debugging — staging

> Date: 2026-05-21
> Host: `cedr-stg-app-03` (Stanford VM, private IP `10.111.37.187/26`, public IP `171.64.13.34` terminated upstream)
> Scope: Diagnose and fix a chain of four unrelated failures that were each blocking `cedarat system-reset` from completing on the staging environment. Final command sequence: `mcedit /etc/nginx/nginx.conf` + `systemctl restart nginx`, `vi /etc/hosts`, `mcedit /etc/neo4j/neo4j.conf` + `systemctl restart neo4j.service`.
> Goal: Get `cedarat system-reset` to run to completion, and document what was broken so the next person doesn't repeat the multi-hour archaeology.

---

## TL;DR

`cedarat system-reset` was failing on the very first step (`Reading admin user from Keycloak`) with a Java `Connection reset` during TLS handshake. Underneath that one symptom were **four distinct, unrelated problems** layered on top of each other. Each had to be fixed before the next one became visible:

1. **Nginx TLS config incompatible with OpenSSL 3 + SECLEVEL=2** → nginx was RST'ing the TLS handshake itself. *Fixed by modernizing `ssl_protocols` / `ssl_ciphers` in `/etc/nginx/nginx.conf`.*
2. **Hairpin-NAT broken on this VM** → even after nginx was healthy, the host couldn't reach its own public hostname (`auth.staging.metadatacenter.org` → `171.64.13.34`) because Stanford's firewall doesn't loop the traffic back cleanly. *Worked around with an `/etc/hosts` pin to `127.0.0.1`.*
3. **APOC procedures sandboxed in Neo4j** → cedarat's `GraphDbCreateIndicesAndConstraints` calls `apoc.schema.assert(...)`, which Neo4j refused to execute. *Fixed by adding `dbms.security.procedures.unrestricted=apoc.*` and `dbms.security.procedures.allowlist=apoc.*` to `neo4j.conf`, then restarting Neo4j.*
4. **Stale Keycloak event-listener JAR** → not blocking system-reset, but throws `NoClassDefFoundError: org.apache.hc.client5.http.fluent.Request` on every successful login. Source has been fixed (uses Keycloak's `HttpClientProvider` + httpclient 4 now), but the deployed jar in `providers/` was built from the older httpclient5-fluent version. **Not yet fixed in staging.**

After (1), (2), and (3), `cedarat system-reset` runs end-to-end. (4) is logged on every login but doesn't break anything functional.

---

## How the chain unrolled

### Symptom that started everything

```
INFO: Reading admin user from Keycloak
Exception in thread "main" jakarta.ws.rs.ProcessingException: RESTEASY004655: Unable to invoke request: java.net.SocketException: Connection reset
    ...
    at org.keycloak.admin.client.token.TokenManager.grantToken
    ...
Caused by: java.net.SocketException: Connection reset
    at sun.security.ssl.SSLSocketImpl.startHandshake
```

Java's REST-Easy admin client was getting a TCP `RST` **during the TLS handshake**, before any HTTP byte was exchanged. This means: it's not Keycloak's HTTP/auth logic that's failing — the connection dies at the transport layer between client and Keycloak.

### Misleading red herring: the event-listener crash

Keycloak's own logs showed this on every login:

```
ERROR [org.keycloak.events.EventBuilder] Failed to send type to ...GenericEventListenerProvider:
    java.lang.NoClassDefFoundError: org/apache/hc/client5/http/fluent/Request
        at org.metadatacenter.keycloak.provider.events.HttpCallExecutor.post(HttpCallExecutor.java:33)
```

For the first hour we thought this was the root cause — that the listener's exception was aborting the response and the client saw it as a connection reset. **That theory was wrong.** The listener fires from `EventBuilder.success`, *after* the response has been committed. A `NoClassDefFoundError` there is logged and swallowed; it doesn't abort the TCP connection. The fact that the cedarat error trace shows `Connection reset` during `startHandshake` (well before HTTP) ruled out application-layer involvement.

The listener bug is still real — see §4 below — but it isn't what was breaking `system-reset`.

### Problem 1 — Nginx TLS config

Confirmed the connection isn't even reaching Keycloak:

```
$ ss -tlnp | grep -E ':(443|8080|8443)'
LISTEN 0 511  0.0.0.0:443   ... nginx
LISTEN 0 4096       *:8080  ... java   ← Keycloak (HTTP only)
# nothing on 8443
```

Keycloak only listens on `:8080`. nginx terminates TLS on `:443` and proxies to `cedar-backend-auth-http` → `127.0.0.1:8080`. So a TLS handshake failure means nginx itself is at fault.

`curl http://127.0.0.1:8080/realms/master/.well-known/openid-configuration` returned the JSON discovery document — Keycloak is healthy. So the failure is *strictly* in nginx's TLS layer.

`nginx -t` passes (config is syntactically valid) but the running nginx was actively RST'ing handshakes. Error log made it concrete:

```
nginx: [crit] *94276 SSL_do_handshake() failed
    (SSL: error:0A0000D7:SSL routines::required cipher missing)
    while SSL handshaking, client: 10.111.29.22, server: 0.0.0.0:443
nginx: [crit] *94307 SSL_read() failed
    (SSL: error:1C800066:Provider routines::cipher operation failed
     error:0A000119:SSL routines::decryption failed or bad record mac)
```

The config (in `/etc/nginx/nginx.conf`) had:

```nginx
ssl_protocols             TLSv1 TLSv1.1 TLSv1.2;
ssl_ciphers               ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:...:DES-CBC3-SHA:!DSS;
ssl_prefer_server_ciphers on;
```

That cipher list is the old Mozilla 2018 "intermediate" profile — it includes 3DES (`DES-CBC3-SHA`, `EDH-RSA-DES-CBC3-SHA`, etc.) and AES-CBC modes. On Ubuntu's OpenSSL 3 at the default `SECLEVEL=2`:

- TLS 1.0 / 1.1 are forbidden at the system level (`MinProtocol = TLSv1.2` in `/etc/ssl/openssl.cnf`).
- 3DES suites and several CBC suites are filtered out.
- The interaction between *listing* TLS 1.0/1.1 in `ssl_protocols` and *not* having TLS 1.3 enabled, while OpenSSL filters most of the cipher list, ends up triggering `SSL_R_REQUIRED_CIPHER_MISSING` (`0xD7`).

**Fix:** in `/etc/nginx/nginx.conf`, replace the three legacy lines with the modern Mozilla intermediate profile:

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
ssl_prefer_server_ciphers off;
```

Then `systemctl restart nginx` (or `nginx -s reload` — but the actual fix isn't applied until you've **edited the file**, which we missed on the first reload attempt).

### Problem 2 — Hairpin NAT

After (1), local TLS worked:

```
$ openssl s_client -connect 127.0.0.1:443 -servername auth.staging.metadatacenter.org
... full cert chain, Verify return code: 0 (ok), real Server certificate ...
```

But the same probe against the public hostname still RST'd:

```
$ openssl s_client -connect auth.staging.metadatacenter.org:443 -servername auth.staging.metadatacenter.org
write:errno=104
... Cipher is (NONE) ...
```

And no new lines in `/var/log/nginx/error.log` from that attempt — meaning **nginx never received the connection**.

The puzzle resolved with:

```
$ ip -4 addr | awk '/inet /{print $2, $NF}'
127.0.0.1/8 lo
10.111.37.187/26 ens192          ← only IP this host owns
$ getent hosts auth.staging.metadatacenter.org
171.64.13.34    staging.metadatacenter.org   ← NAT'd by Stanford firewall, NOT on this box
```

This VM has private IP `10.111.37.187`. The public `171.64.13.34` is terminated by an upstream Stanford firewall doing 1:1 NAT. When this host tries to connect *outbound* to its own public IP, the packets are RST'd somewhere in the network path — classic hairpin-NAT failure. External clients (browsers, real users) reach Keycloak fine; only the host trying to reach itself via its public hostname fails.

**Fix:** pin `auth.staging.metadatacenter.org` to loopback for processes on this host:

```bash
echo '127.0.0.1 auth.staging.metadatacenter.org' | sudo tee -a /etc/hosts
```

TLS still works because the LE cert's SAN includes that hostname. cedarat's REST-Easy client now talks to local nginx, which proxies to local Keycloak.

### Problem 3 — Neo4j APOC sandboxing

With Keycloak now reachable, `system-reset` got past `Reading admin user from Keycloak` and into the next phase — and immediately died:

```
INFO: Removing all constraints and indices
ERROR org.neo4j.driver.exceptions.ClientException:
    apoc.schema.assert is unavailable because it is sandboxed and has dependencies outside of the sandbox.
    Sandboxing is controlled by the dbms.security.procedures.unrestricted setting.
    Only unrestrict procedures you can trust with access to database internals.
```

CEDAR's `Neo4JProxyAdmin.removeAllConstraintsAndIndices` issues `CALL apoc.schema.assert({}, {});`. APOC procedures that touch DB internals (most of `apoc.schema.*`, `apoc.refactor.*`, etc.) are sandboxed by default in Neo4j and have to be explicitly unrestricted.

**Fix:** add to `neo4j.conf`:

```
dbms.security.procedures.unrestricted=apoc.*
dbms.security.procedures.allowlist=apoc.*
```

Then `systemctl restart neo4j.service`. After this, `cedarat system-reset` runs to completion.

### Problem 4 — Stale Keycloak event-listener JAR (still pending)

Independent of (1)–(3), every successful Keycloak login on this server still throws:

```
ERROR [org.keycloak.events.EventBuilder] Failed to send type to ...GenericEventListenerProvider:
    java.lang.NoClassDefFoundError: org/apache/hc/client5/http/fluent/Request
        at HttpCallExecutor.post(HttpCallExecutor.java:33)
```

The deployed JAR at `/srv/cedar/keycloak/providers/cedar-keycloak-event-listener.jar` was built from an older version of `HttpCallExecutor` that used Apache HttpClient 5's fluent API (`org.apache.hc.client5.http.fluent.Request`). Keycloak ships `httpclient5` core but **not** `httpclient5-fluent`, so the class isn't on the classpath.

The CEDAR source has already been fixed — `HttpCallExecutor` now uses Keycloak's `HttpClientProvider` + httpclient 4 (`org.apache.http.*`), which is on the classpath natively. Confirmed by inspecting the freshly built jar in `cedar-keycloak-event-listener/target/`:

```
$ unzip -p .../target/cedar-keycloak-event-listener.jar \
    org/metadatacenter/keycloak/provider/events/HttpCallExecutor.class | strings | grep apache/h
org/apache/http/client/methods/HttpPost
org/apache/http/entity/StringEntity
org/keycloak/connections/httpclient/HttpClientProvider
... (no hc.client5/fluent references)
```

The fix is to **deploy that fresh jar** to `/srv/cedar/keycloak/providers/` on each environment, then `kc.sh build && systemctl restart keycloak`. We did not do that on `cedr-stg-app-03` during this debugging session because (a) it isn't blocking `system-reset` and (b) it would have added a restart cycle to an already long session.

---

## What we ran, in order, that actually fixed it

```bash
# 1. Modernize nginx TLS — replace the three ssl_* lines in nginx.conf (see Problem 1 above)
mcedit /etc/nginx/nginx.conf
systemctl restart nginx

# 2. Bypass hairpin-NAT — add  127.0.0.1  auth.staging.metadatacenter.org  to /etc/hosts
vi /etc/hosts

# 3. Unsandbox APOC in Neo4j — add the two procedures lines to neo4j.conf
mcedit /etc/neo4j/neo4j.conf
systemctl restart neo4j.service

# 4. Run the operation
cedarat system-reset
```

Neo4j config path on this host is **`/etc/neo4j/neo4j.conf`** (the OS-package install path), not the bundled-tarball path I'd guessed earlier (`/srv/cedar/neo4j/conf/neo4j.conf`). That's worth noting for the next person: this VM uses the Debian/Ubuntu `neo4j` package, so config lives under `/etc/neo4j/`, data under `/var/lib/neo4j/`, logs under `/var/log/neo4j/`, and the service is managed by systemd as `neo4j.service`.

---

## What's still broken / could be improved

### Must-do follow-ups

1. **Deploy the fixed event-listener jar to all environments.** Stop the `NoClassDefFoundError` spam on every login.
   ```bash
   # From an environment that has the built jar:
   scp /Users/atti/CEDAR/cedar-keycloak-event-listener/target/cedar-keycloak-event-listener.jar \
       cedar@cedr-stg-app-03:/tmp/
   ssh cedar@cedr-stg-app-03
   sudo mv /tmp/cedar-keycloak-event-listener.jar /srv/cedar/keycloak/providers/
   sudo /srv/cedar/keycloak/bin/kc.sh build
   sudo systemctl restart keycloak
   ```
   Repeat for production and any other CEDAR Keycloak install.

2. **Keycloak `--hostname` / `--proxy` is misconfigured.** The OIDC discovery doc returns a split set of URLs:
   ```json
   "issuer": "https://auth.staging.metadatacenter.org/realms/master",
   "authorization_endpoint": "https://auth.staging.metadatacenter.org/...",
   "token_endpoint": "http://127.0.0.1:8080/...",      ← should be https://auth.staging...
   "userinfo_endpoint": "http://127.0.0.1:8080/...",   ← same
   "jwks_uri": "http://127.0.0.1:8080/..."             ← same
   ```
   This means `--hostname` and/or `--proxy=edge` aren't set correctly. For Keycloak 22 (Quarkus) behind an nginx that terminates TLS, the typical config in `keycloak.conf` is:
   ```
   hostname=auth.staging.metadatacenter.org
   hostname-strict=true
   hostname-strict-backchannel=true
   proxy=edge
   http-enabled=true
   ```
   Any consumer that uses `.well-known/openid-configuration` to discover endpoints (e.g. a generic OIDC client) will currently try to reach `http://127.0.0.1:8080/...` and fail. cedarat works around this because it uses `KeycloakBuilder.serverUrl(...)` with an explicit URL, not discovery.

3. **Make the nginx TLS fix survive Puppet.** The `nginx.conf` file starts with `# MANAGED BY PUPPET`. Whatever Puppet manifest renders that file will overwrite the fix on the next Puppet run, restoring the broken `ssl_protocols TLSv1 TLSv1.1 TLSv1.2` config. The Puppet module needs to be updated to match what we hand-edited — otherwise this problem comes back the next time Puppet runs (or the next time the VM is rebuilt from a baseline).

### Nice-to-have improvements

4. **Fix the hairpin NAT properly.** The `/etc/hosts` override is a per-host band-aid. Any other host inside Stanford's network that tries to reach `auth.staging.metadatacenter.org` from a position where the NAT also fails will hit the same bug. The clean fix is split-horizon DNS (return `10.111.37.187` to internal queries, `171.64.13.34` to external ones), but that requires Stanford networking changes. Alternative: a CEDAR-local DNS resolver (dnsmasq / unbound) on each app host that overrides only the `*.staging.metadatacenter.org` names. Either is better than `/etc/hosts` because it doesn't need touching every CEDAR host.

5. **Audit other CEDAR public hostnames for the same hairpin issue.** If `auth.staging.metadatacenter.org` is broken, then `api.staging…`, `repo.staging…`, `valuerecommender.staging…`, etc. are too. Each service running on this host that calls another via the public hostname will fail the same way. Quick check:
   ```bash
   sudo nginx -T 2>/dev/null | awk '/server_name/ {for(i=2;i<=NF;i++) print $i}' \
     | tr -d ';' | grep -v '^_$' | sort -u
   ```
   Any of those hostnames that other-services-on-this-box need to call should be added to `/etc/hosts`. Or fix it at the DNS layer per (4).

6. **Audit APOC unrestricted scope.** We set `dbms.security.procedures.unrestricted=apoc.*` and `allowlist=apoc.*` — wildcards. That's fine for CEDAR's use case (we trust the apoc library and CEDAR uses many of its procs), but it does grant the most permissive setting available. If you want least-privilege, narrow to the actual procedures CEDAR calls:
   ```
   dbms.security.procedures.unrestricted=apoc.schema.*,apoc.refactor.*,apoc.create.*,...
   ```
   To find the actual list, grep CEDAR's Cypher strings:
   ```bash
   grep -RIn 'apoc\.' /Users/atti/CEDAR --include='*.java' --include='*.cql' | head -50
   ```

7. **Document the four-issue chain in CEDAR's deployment / troubleshooting docs.** This whole debugging took multiple hours. The clues for each layer were buried — first the Keycloak event-listener crash *looked* like the root cause but wasn't; the TLS error code `0A0000D7` is uncommon; the hairpin NAT is invisible from inside the host until you compare local IPs to DNS resolution. A page in `cedar-docs` / `cedar-development` titled something like "Troubleshooting `cedarat system-reset`" with the symptom → fix mapping would save the next person.

8. **Add a pre-flight check to `cedarat`.** It would be valuable for `cedarat` (or a separate `cedarat doctor` subcommand) to do health checks before attempting destructive operations:
   - `curl -sSf $KEYCLOAK_URL/.well-known/openid-configuration` (proves auth reachable)
   - `cypher-shell ... 'CALL apoc.help("apoc.schema.assert")'` (proves APOC available + unrestricted)
   - DNS sanity (`auth.X` resolves locally to `127.0.0.1`)
   These are the three failure modes we hit. A 30-second preflight that surfaces each as a clear "fix this first" message would be much more useful than the current "make an admin call, get a 400-byte stack trace, debug for hours" experience.

---

## Why these four happened together

The cascading failure here was unusually long because each layer **hid** the next:

- Layer 4 (event-listener JAR) was spamming visible errors in Keycloak's log — natural first suspect, but actually independent.
- Layer 1 (nginx TLS) prevented us from even seeing Keycloak respond, masking layers 2 and 3.
- Layer 2 (hairpin NAT) only revealed itself after layer 1 was fixed, because before that *everything* was failing at the cipher stage.
- Layer 3 (APOC sandbox) wasn't reachable until 1+2 let auth complete.

The OS / package upgrade that likely caused most of this (OpenSSL 3, modern Ubuntu, newer Neo4j) updated all four sub-systems' assumptions at once — but the Puppet manifests, the deployed event-listener jar, the network topology, and the Neo4j defaults were all left at the pre-upgrade state. So instead of one "after the upgrade, X broke," we got four overlapping breakages, each requiring its own fix.
