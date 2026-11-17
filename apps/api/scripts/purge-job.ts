/**
 * The purge job (`045` design D2): phase 2 of the org deletion, run as `tayzu_purge` once a
 * tenant's window has passed, in two idempotent steps (catalog rows, then Better Auth
 * rows). Filled in by the tasks of group 6; started by the `identity:purge` package script.
 */
export {};
