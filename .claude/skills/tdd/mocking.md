# When to mock

Mock at **system boundaries** only, and only where the runtime can't give you the real thing locally.

| Boundary | In tests |
|----------|----------|
| R2, KV, Queues, D1 | **Don't mock.** Code that uses a binding is one of the cases that needs workerd (SKILL.md, *Rules of the loop*): Miniflare gives real local bindings, declared in the workspace's `vitest.config.ts` (`spikes/better-auth` declares `d1Databases`). Assert on what the binding holds. Keep the code that touches bindings thin, so the logic around it tests in Node. |
| Postgres through Hyperdrive | Use the test database the `packages/db` helpers provide. Never mock SQL or the query layer. If no helper exists yet, that's a gap for the notes or a consult, not a reason to stub. |
| The email provider (Resend) | A stub sender, injected. No test calls a real provider (`/gate`, mailer protocol). |
| Turnstile | Cloudflare's published test site key and secret, which always pass or always fail. |
| Time | Inject a clock. Rate limits, quotas, expiries and "is this upload newer" all need a fixed now. |
| Randomness | Don't pin it. Assert the property instead: two responses carry different CSP nonces. |
| The filesystem | Node tests read it directly. workerd has none: a Node `globalSetup` reads the files and `provide`s them (`packages/epub/test/global-setup.ts`). |

Don't mock:

- Your own modules, or anything inside `packages/` or `apps/`
- Internal collaborators: the sanitizer's tokenizer, the serializer, a query builder
- Anything you control

## Designing for mockability

At those boundaries, design interfaces that are easy to stub.

**1. Pass dependencies in.** A Worker's dependencies are its `env` bindings; wrap a provider in a small interface built from `env`, and let tests pass their own.

```typescript
// Easy to stub
export async function sendSignInLink(msg: SignInMail, senders: Sender[]) {
  for (const sender of senders) { /* first that accepts wins */ }
}

// Hard to stub
export async function sendSignInLink(msg: SignInMail, env: Env) {
  const resend = new Resend(env.RESEND_KEY);
  /* ... */
}
```

**2. One function per operation.** A sender exposes `sendBatch(messages)`, not a generic `request(path, options)`.

- Each stub returns one specific shape
- No conditional logic in test setup
- It's clear which operations a test exercises
- Type safety per operation
