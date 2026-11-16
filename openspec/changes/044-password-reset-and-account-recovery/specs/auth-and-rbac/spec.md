# Spec Delta: auth-and-rbac

## MODIFIED Requirements

### Requirement: Authentication responses resist account enumeration
Sign-in responses MUST NOT reveal whether an email address has an account. A
failed sign-in MUST return the same status, error code, and body shape
whether the account does not exist, the password is wrong, or the account is
disabled. There is no sign-up surface to protect (see "Public self sign-up is
not available"). The forgot-password and account-recovery surface is specified
by the `password-reset-and-account-recovery` capability, which carries its own
enumeration requirement for the reset request and the reset confirmation; this
requirement covers the sign-in surface.

#### Scenario: Sign-in failure looks the same for an unknown account and a wrong password
- **GIVEN** one email with no account and one email with an account and a known password
- **WHEN** sign-in is attempted for the first with any password, and for the second with the wrong password
- **THEN** both attempts fail with the same status, error code, and body shape
