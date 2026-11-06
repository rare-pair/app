# Scenario: Email failover to a second provider

Relates to: docs/ARCHITECTURE.md § Auth (Email: Resend only); specs/scenarios/mvp/01-auth-magic-link.md

There is no failover provider at launch (operator ruling, 2026-11-05): until this is built, an outage at Resend stops sign-in until it returns.

## Setup
- The mailer Worker (`apps/mailer`) consumes the `email` queue, with a stub Resend sender and a failover provider stub wired in

## Cases

### Email sending fails over to the second provider
- GIVEN Resend is refusing messages (rate limit, quota or outage)
- WHEN a sign-in email is taken off the email queue
- THEN it is sent through the failover provider instead
