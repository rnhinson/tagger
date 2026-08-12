# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

Use GitHub's **[Report a vulnerability](https://github.com/rnhinson/tagger/security/advisories/new)**
(Security → Advisories) to open a private advisory. Include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected version / commit.

You'll get an acknowledgement, and we'll work with you on a fix and coordinated
disclosure. Please give a reasonable window to release a fix before any public
disclosure.

## Scope & notes

tagger is designed to run on a trusted network and it **reads, writes, and
deletes files** in the directories you mount. When exposing it beyond a trusted
LAN:

- set `TAGGER_PASSWORD` to require a login, and
- serve it over HTTPS behind a reverse proxy with `TAGGER_SECURE_COOKIE=1`.

See the [self-hosting guide](docs/SELF-HOSTING.md) for details.
