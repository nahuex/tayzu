## ADDED Requirements

### Requirement: Administrators are warned before the purge

A daily scheduled warning job, separate from the purge job, MUST send a fixed pre-purge
warning to the administrators of every organization whose pending deletion marker falls
due between 24 and 48 hours after the job runs (`purge_after` later than 24 hours and at
most 48 hours from now), at most once per marker. The warning MUST be a fixed template whose
only interpolated value is the purge date, with no link and no tenant, actor or
organization free text, and MUST go through the same controls as the deletion notice: one
email per recipient, at most 20 administrators (those who have been members the longest),
the global kill switch, the notices' own per-recipient cap, the per-tenant notice cap and
the list of disabled tenants. A suppressed or truncated warning MUST be logged as
`catalog.security.notice_suppressed`. The job MUST record that a marker was warned before it
sends, so that no marker is warned twice even when two runs overlap, and a send failure
MUST be logged as `catalog.security.org_deletion_warning_failed` and MUST NOT stop the
warnings of other tenants. For every marker it claims, the job MUST emit
`catalog.audit.org_deletion_marker_seen` with the tenant id alone, before it sends, so that a
marker with no matching deletion request can be detected before its purge.

The job MUST run as its own database role, used only by that job with its own secret, that
can read only the tenant, the purge date, the state and the warned time of pending markers
inside that window and can write only the warned time, which the database MUST stamp with
its own clock; the request role MUST NOT be able to set the warned time, and the purge role
MUST gain no privilege. Like the purge and the reversal, the job MUST refuse to run with
telemetry disabled or without an export endpoint, before any database or email work, and
MUST flush its telemetry before it exits.

#### Scenario: Only markers due in 24 to 48 hours are warned

- **GIVEN** pending markers due in 23 hours, 25 hours, 47 hours and 49 hours, and a cancelled marker due in 30 hours
- **WHEN** the warning job runs
- **THEN** only the organizations whose markers are due in 25 and 47 hours are warned, and each of those markers now has a warned time

#### Scenario: A marker is warned once

- **GIVEN** a pending marker due in 30 hours
- **WHEN** the warning job runs twice, one run after the other or both at the same time
- **THEN** each administrator receives exactly one warning, and `catalog.audit.org_deletion_marker_seen` is emitted once for that tenant

#### Scenario: The warning carries no free text

- **GIVEN** an organization named `<b>Pay now</b>` and an admin with a markup-bearing name
- **WHEN** the warning is sent
- **THEN** neither string appears, the warning has no link, and its only variable is the purge date

#### Scenario: The warning is under the notice controls

- **GIVEN** the kill switch is on, or the per-tenant notice cap is exhausted, or a recipient's notice bucket is full, or the tenant is on the list of disabled tenants
- **WHEN** the warning job runs for that tenant's due marker
- **THEN** no email goes to the affected recipients, the suppression is logged with the template `org_deletion_warning` and the reason, and the marker is still recorded as warned

#### Scenario: The warning goes to at most 20 administrators

- **GIVEN** an organization with 25 administrators and a marker due in 30 hours
- **WHEN** the warning job runs
- **THEN** exactly 20 warnings are sent, to the administrators who have been members the longest, and the truncation is logged

#### Scenario: A failed send does not block other tenants

- **GIVEN** two tenants with markers due in 30 hours, and an email provider that fails for the first
- **WHEN** the warning job runs
- **THEN** `catalog.security.org_deletion_warning_failed` is logged for the first tenant, the second tenant's administrators are warned, and the job completes

#### Scenario: The warning role is narrow

- **WHEN** the warning role reads a pending marker outside the window, a cancelled or purged marker, or the requesting actor of any marker, or writes any column other than the warned time, or the request role inserts a marker with a warned time
- **THEN** the database refuses each, and no other role of the platform can `SET ROLE` to the warning role

#### Scenario: The warning job needs telemetry

- **WHEN** the warning job starts with telemetry disabled, or with no export endpoint
- **THEN** it exits non-zero before any database or email work and warns no one
