# Security Policy

Thanks for taking the time to look at Marina's security posture. This file describes how to report a vulnerability and what we promise in return.

## Supported versions

Only the current `main` branch and the latest tagged release receive security fixes. The project is at `0.x` — no long-term support branches yet.

## Reporting a vulnerability

**Do not open a public issue for a suspected vulnerability.** Public issues are indexed by search engines and watched by bots; an unfixed CVE in plain view puts every running instance at risk before a patch can ship.

Use one of:

1. **GitHub private security advisories** (preferred). On this repository, go to **Security → Advisories → Report a vulnerability**. This creates a private channel between you and the maintainers. GitHub handles CVE assignment if needed.
2. **Email** — send to the project maintainer listed in `package.json` or in the repository's GitHub profile. PGP welcome but not required.

Please include:

- A description of the vulnerability and its impact.
- A minimal reproduction (commands, payload, world definition — whichever applies).
- The Marina version (`git rev-parse HEAD` or the release tag).
- Your assessment of severity and any suggested mitigations.

## What to expect

- **Acknowledgement** within 3 business days.
- **Triage and assessment** within 10 business days. We'll tell you whether we're treating it as a vulnerability, what severity we assign, and an indicative timeline.
- **Coordinated disclosure**. We aim to ship a fix and publish an advisory together. By default we credit reporters in the advisory; tell us if you'd rather stay anonymous.
- **Embargo** of up to 90 days from acknowledgement, extended only by mutual agreement.

## In scope

- The Marina server (`src/`, `worlds/`, `scripts/`).
- The dashboard (`dashboard/`).
- The desktop app (`marina-desktop/`).
- The SDK (`src/sdk/`) and examples that ship with it.
- Default world definitions and their seed data.

## Out of scope

- Vulnerabilities in third-party services Marina talks to (Anthropic API, OpenRouter, Kalshi, Polymarket, etc.) — report those upstream.
- Issues that require a malicious operator already running with admin rank on a given instance — that's a configuration concern, not a vulnerability.
- DoS via excessive command queuing on an unauthenticated dev instance running with `MARINA_OPEN_API=true`. The flag is documented as dev-only.
- Findings in dependencies that have no impact on Marina's actual usage of them — please open an issue against the dependency itself.

## Hall of fame

Reporters who follow this policy and help us ship a fix are credited in the corresponding advisory and in `CHANGELOG.md`. We don't run a paid bounty program.
