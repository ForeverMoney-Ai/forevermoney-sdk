# Security policy

## Supported versions

Until the SDK reaches 1.0, security fixes are released only for the latest
published minor version.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Submit a private
[GitHub security advisory](https://github.com/ForeverMoney-Ai/forevermoney-sdk/security/advisories/new)
with the affected version, impact, reproduction steps, and any proposed fix.

Never include a private key, seed phrase, authenticated RPC URL, or user data in
a report. Use fresh test accounts and redact provider credentials.

The SDK prepares unsigned transactions and does not custody keys. Reports about
wallet signing prompts, transaction construction, deployment metadata, receipt
validation, bridge tracking, and dependency compromise are in scope.
