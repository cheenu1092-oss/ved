# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.7.x   | ✅ Current         |
| < 0.7   | ❌ No backports    |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email **cheenu1092@gmail.com** with:

1. Description of the vulnerability
2. Steps to reproduce
3. Impact assessment (what can an attacker do?)
4. Suggested fix (if you have one)

You'll receive an acknowledgment within 48 hours and a detailed response within 7 days.

## Security Model

Ved's security is built on defense-in-depth:

- **Hash-chain audit log** — every action is logged with SHA-256 chain integrity
- **HMAC external anchoring** — tamper evidence via external HMAC signatures
- **4-tier trust system** — owner, trusted, default, untrusted with escalation controls
- **Human-in-the-loop** — high-risk tool calls require explicit human approval
- **Content filtering** — 11-pattern sensitive data filter with NFKC normalization
- **Path containment** — all vault I/O is confined to the vault root
- **Parameterized SQL** — no string interpolation in queries

## Vulnerability History

21 vulnerabilities found and fixed across 7 red-team sessions. See CHANGELOG.md for details.

All security fixes include regression tests to prevent reintroduction.
