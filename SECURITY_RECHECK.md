# Encryption and anonymity recheck — 1 October 2026

Reviewed application checkout `def8dad` after the earlier remediation. This is a source review, bounded local reproductions, automated checks, and three read-only live requests. It is not an independent cryptographic audit. Application code and deployment settings were not changed. The previous review remains in SECURITY_REVIEW.md.

## Follow-up remediation in the workspace

The findings below describe the pre-fix checkout. The follow-up now requires authentication for private/group live messages, history and edits, rejects mixed routing metadata, prevents administrator moderation from changing room access, and clears current/obsolete/legacy private keys and peer pins on explicit sign-out. Cross-tab clients are invalidated, and key-free revocation markers prevent retired identities from being restored. Production/Railway startup requires an exact HTTPS origin; existing HSTS response coverage remains in place. Additional cryptographic context checks prevent valid group ciphertext from being relabelled as a private message while preserving compatibility with earlier private envelopes.

`scripts/security-recheck.mjs` now asserts corrected behavior and is available through `npm run test:security:browser`. Deployment and provider settings have not been changed. Live HSTS and Cloudflare NEL remain deployment tasks. Forward secrecy, malicious-server roster trust and network anonymity still require broader protocol/infrastructure changes; this patch does not claim to provide them.

Follow-up validation: all 31 automated tests, the expanded security browser check, and the private-chat browser check passed. The editing browser check reached and passed public/private/group text and image-caption editing, then failed the pre-existing mobile horizontal-overflow assertion at line 83; later assertions were not reached. No layout changes were included in this security patch.

Deployment actions still required: set `ORIGIN=https://silenzachat.cc` before deploying (and `NODE_ENV=production` on non-Railway hosts), deploy these changes, verify `Strict-Transport-Security: max-age=31536000` at the public edge, and disable Cloudflare Network Error Logging in the zone configuration if minimizing that telemetry. Hosting administration tools/credentials were not available in this task. No deployment or provider modification was performed.

## Conclusion

Supported-client private messages, images, and temporary-room messages use real authenticated browser encryption. The private browser test confirmed ciphertext-only uploads and no tested plaintext or secret-key disclosure in captured requests. No new ordinary-user plaintext-read bypass or unauthenticated administrator bypass was found in the reviewed paths. This conclusion covers the tested behavior, not every possible vulnerability.

Encryption still lacks forward secrecy and depends on trusted delivered JavaScript. The service provides pseudonyms rather than network anonymity. Additional authenticity, recipient-consent, key-retention, and deployment issues remain.

## Findings

### Medium: private live events can bypass authentication by omitting the encrypted envelope

Evidence: public/app.js:223–246. `receive()` chooses whether to decrypt based on `message.encrypted`, rather than requiring encryption for all private/group messages. A matching private message without an encrypted envelope is rendered directly using its supplied text. The local browser probe inserted such a relay event and confirmed the text appeared while the composer still said “End-to-end encrypted.” The same conditional handles group live events, although the probe exercised a private conversation only.

Threat boundary: this requires a malicious/compromised relay or delivery path capable of replacing an event. The normal server rejects plaintext private-message submissions, and TLS protects ordinary network delivery. This reproduction did not show an ordinary participant exploiting the production server, disclose existing ciphertext, or cause outgoing plaintext transmission. It demonstrates that the client fails to enforce its authenticity guarantee for this input. Malicious delivered JavaScript remains a separate, broader limitation.

Recommended correction: classify messages by conversation, require a valid encrypted envelope for every private/group history entry, live message, and edit, and render content only after successful authentication. Reject contradictory room/peer/group metadata. Test missing/null/invalid envelopes in both history and live updates.

### Medium: administrators can change invite-only recipient policy and receive future messages

Evidence: lib/groups.mjs:37–48, 145–158; public/app.js:452–462. Admin moderation applies `details(input)`, including `access`, without requiring ownership. A local probe created an invite-only room, confirmed the administrator initially could not join, changed it to open through moderation, joined without the owner's invitation, and decrypted a subsequent owner message encrypted for the updated roster.

This is an existing authorized moderation capability, not a cryptographic break or administrator-role bypass. It weakens the expected boundary of owner-controlled invite-only access. Existing members receive roster updates, so the added recipient is observable; no explicit sender approval is required before the next send. Earlier messages are not made readable by joining.

Recommended correction: reserve recipient/access decisions for the owner, while allowing admins to remove rooms and moderate descriptive metadata. If admins must retain access changes, explain that power in the privacy guide and require explicit acknowledgement of newly added recipients before sending. Stronger protection against a malicious server also requires an authenticated membership protocol, rather than trusting its roster.

### Medium on shared/compromised devices: logout retains old private keys

Evidence: public/crypto.js:185 stores identity key pairs under session IDs; logout in server.mjs:206 and public/app.js:716 invalidates the session but does not erase its IndexedDB identity. The browser probe logged out, waited for the landing-page navigation, and confirmed the old identity's `secretKey` was still present.

This does not make a logged-out cookie usable or give another remote visitor access. Someone with later access to that browser's site storage can obtain the retained key. Because the protocol has no forward secrecy, a retained key can decrypt previously captured ciphertext for that identity. This limitation was identified in the prior review and remains unchanged.

Recommended correction: implement deliberate local key/trust-record removal on explicit logout, accounting for other tabs and legacy migration storage. Document that browser storage deletion is not guaranteed forensic erasure. Use a maintained reviewed ratcheting protocol if past-message protection after key compromise is required; deleting a key at logout does not provide forward secrecy during an active session. See the [Double Ratchet specification](https://signal.org/docs/specifications/doubleratchet/).

### Medium, live deployment: HSTS is still absent

Fresh read-only requests returned HTTP 301 to HTTPS, and HTTPS 200 for `/` and `/crypto.js`. Both HTTPS responses lacked `Strict-Transport-Security`. The local application has an HTTPS-ORIGIN HSTS implementation, covered by passing tests, so the effective deployed configuration or edge behavior still needs correction. These requests cannot determine whether old server code, ORIGIN configuration, or header handling is responsible.

Recommended correction: deploy/configure the existing HSTS fix and verify the header at the public edge. An HTTPS redirect alone is not a persistent browser HTTPS policy. Subdomains/preload need a separate deployment decision.

### Low, live privacy: Cloudflare network-error reporting remains enabled

The live responses still advertise `NEL` and `Report-To` with a Cloudflare reporting endpoint, `success_fraction: 0.0`, and a seven-day policy. This permits browser network-error reporting; it does not establish reporting of every request or private plaintext. Provider configuration was not inspected or changed. Review/disable it if minimizing telemetry is intended. See [Cloudflare NEL documentation](https://developers.cloudflare.com/network-error-logging/).

## Encryption and anonymity limits

- Static X25519/XSalsa20-Poly1305 boxes authenticate encrypted content using fresh random nonces; images have independent random secretbox keys. Metadata bindings and low-order-key rejection are present. [TweetNaCl documentation](https://github.com/dchest/tweetnacl-js) describes the underlying primitives; its audit is not an audit of this application.
- No forward secrecy or post-compromise recovery. First-contact key substitution requires independent identity-code comparison to detect. New sessions establish new trust relationships.
- The server controls delivered browser JavaScript and the group roster. An operator able to alter that code can capture plaintext and keys. Current protocol checks do not remove this trust requirement.
- Aliases do not hide IP addresses, timing, data sizes, private-contact relationships, or room membership from the operator/infrastructure. Public activity remains visible to other visitors, and the online directory enables presence tracking across a session. Account usernames enable longer-term correlation; guest-to-account identity rotation does not hide timing/content correlations.
- Recent ciphertext and attachments are temporary server memory. Accounts, blocks, bans, feedback, and announcements have disk persistence. Provider access logs, backups, crash dumps, actual proxy trust, and retention settings remain unverified.

## Validation

| Check | Result |
| --- | --- |
| `npm test` | All 29 tests passed, including previous remediation regressions |
| `npm run test:browser` | Passed private encryption/images, traffic inspection, third-party isolation, verification, key change/loss, reload/shared tabs, and deletion |
| `npm run test:groups:browser` | Encryption, images, membership isolation, kicks and key-substitution checks passed before the mobile horizontal-overflow assertion failed at line 153; later assertions were not reached |
| `node scripts/security-recheck.mjs` | All three bounded reproductions confirmed: plaintext live-event acceptance, retained logout key, and admin recipient-policy change |
| `npm audit --omit=dev --json` | Zero reported production dependency vulnerabilities at the time of checking |
| Live `/crypto.js` | Matched local source after newline normalization |
| Live HTTP/HTTPS headers | Redirect and CSP present; HSTS absent; Cloudflare NEL/Report-To present |

Browser/network checks initially hit sandbox restrictions and were rerun successfully with reviewed access. Local tests used disposable data and profiles, not real accounts or the environment file. No production guest/account creation, messages, admin mutations, intrusive scans, or load tests were performed. Only the deployed encryption asset was compared; deployed server code and infrastructure settings remain unverified.

The original reproduction assertions described above confirmed the historical findings. The script has since been converted into regression checks for the corrected behavior; see the remediation section.
