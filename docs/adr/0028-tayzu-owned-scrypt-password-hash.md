# ADR-0028: A Tayzu-owned scrypt password hash at OWASP's current cost

- **Status**: Accepted
- **Date**: 2026-11-28
- **Change**: [`048-production-hardening`](../../openspec/changes/048-production-hardening/design.md) (design D5; Resolved decisions Q8, Q27 and Q33)

## Context

Until `048`, every password Tayzu stored was hashed by Better Auth's default:
`scrypt` from `@better-auth/utils@0.4.2` with fixed parameters `N=16384`,
`r=16`, `p=1`, a 64-byte key and a `salt:key` hex format. `002` (Q78) accepted
that default for its merge and made the hash parameters a first-deployment
gate, and `043` (O-4) asked for OWASP's current values with a rehash on
sign-in. The installed function takes no cost option, applies NFKC inside, and
compares keys with `===`, not in constant time. Changing the cost therefore
means Tayzu owns its hash and verify functions. No user exists before the
first deployment.

## Decision

1. **Parameters.** `scrypt` (`node:crypto`) with `N=2^15`, `r=8`, `p=3`, a
   64-byte key, a random 16-byte salt and an explicit `maxmem` of 64 MiB. This
   is one of OWASP's equivalent scrypt settings: 32 MiB per hash, the same
   memory as before, and about three times the CPU (Q8).
2. **Format.** `$scrypt$ln=15,r=8,p=3$<salt>$<key>`, with the salt and the key
   in unpadded standard base64. Verification parses the format strictly
   (`ln` 14 to 20, `r` and `p` 1 to 16, in that order, a salt of 16 to 64
   bytes, a 64-byte key, no extra field or padding) and answers `false`,
   never throwing, for anything else.
3. **Normalization.** The password is NFC-normalized, and nothing else, before
   it is hashed or verified.
4. **Comparison.** The recomputed key is compared with `timingSafeEqual`.
5. **Legacy hashes.** A stored `salt:key` hash still verifies through
   `better-auth/crypto`'s own function.
6. **Rehash.** After a successful local sign-in (Q27: once the password has
   verified and the reset-race check has passed, whether or not a second
   factor follows), a legacy or lower-cost hash is rewritten with a
   compare-and-set on the stored value. A concurrent reset always wins, and a
   failed rewrite logs the sanitized `auth.internal_error` and does not fail
   the sign-in.
7. **Equal failure cost.** A failed check against a weaker hash runs one
   current-cost hash before it answers, so it costs the same as a sign-in for
   an unknown email, which Better Auth hashes at the configured cost (Q33).
8. **One function.** Sign-in, sign-up, user creation, the bootstrap,
   `/change-password`, invitation acceptance and the reset all hash through
   this function.

## Alternatives

- **`N=2^17`, `r=8`, `p=1`**, OWASP's first-listed scrypt setting: 128 MiB per
  hash, and up to 512 MiB with libuv's four threads hashing at once, on a
  public, rate-limited route in a small container.
- **Argon2id**, OWASP's first choice: it needs a native dependency with
  install scripts and its own design amendment.
- **Refusing legacy hashes:** possible while no user exists, but the next
  cost change would need the rehash anyway (Q8).

## Consequences

- **Measured time.** The current cost takes 191 ms per hash (the median of ten
  runs) in the 4-vCPU cloud sandbox, the same class as the 4-vCPU GitHub
  runner. `enumeration-resistance.int.test.ts` measures sign-in classes on
  the CI runner on every run.
- **Rehash and reset.** The rehash and the `044` reset both write
  `auth.account.password`. The compare-and-set makes the reset win. A sign-in
  that loses the race is refused like a wrong password, exactly as the
  existing reset-race check refuses it.
- **Failure cost.** A failed check against a weaker hash does two
  derivations: its own and one at the current cost. A successful check does
  one.
- **Residual risk.** The legacy path keeps `better-auth/crypto`'s `===`
  comparison inside `@better-auth/utils@0.4.2`. No legacy hash exists in
  production: every password set after `048` is in the platform format.
- **Memory bound.** The accepted parameter range (`ln=20`, `r=16`) would let a
  stored hash ask for about 2 GiB. Only Tayzu writes stored hashes, so this
  is not reachable from a request, but a future cost change keeps the range
  in mind.
- **Better Auth upgrades.** The hash and verify functions are passed to Better
  Auth by reference. A Better Auth upgrade cannot change the cost silently.
