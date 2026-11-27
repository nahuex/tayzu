# ADR-0027: OpenTofu for Tayzu's Azure infrastructure

- **Status**: Accepted
- **Date**: 2026-11-27
- **Change**: `046-azure-deployment-and-first-release` (roadmap decision D14 in
  [`openspec/project.md`](../../openspec/project.md))

## Context

`openspec/project.md` §7 and §9 (Pipeline-as-Code) require Tayzu's Azure
infrastructure to be versioned code, in "Bicep or Terraform". The first
deployment (`046`) needs the IaC for Azure Container Apps (the API with its
Cerbos sidecar and the maintenance jobs), Azure Database for PostgreSQL
Flexible Server, Key Vault, Azure Monitor (Log Analytics and Application
Insights) and Azure Container Registry. On 2026-11-27 the human chose among:

- **Bicep**, the recommended option: Azure-native, no state file to protect,
  `what-if` previews and Azure Verified Modules;
- **Terraform** with the `azurerm` provider;
- **OpenTofu**, the open-source fork of Terraform under the Linux Foundation.

## Decision

Tayzu's Azure infrastructure is written for **OpenTofu**, with the `azurerm`
provider (and `azapi` only where `azurerm` lacks a resource or property).

1. The OpenTofu binary and every provider are pinned to exact versions, each
   the latest release published at least 14 days earlier (the dependency age
   rule of `003` Q43). The provider lock file `.terraform.lock.hcl` is
   committed with the hashes of every platform CI uses.
2. Remote state lives in an Azure Storage account reached by the `azurerm`
   backend through Entra ID (no storage access key), with OpenTofu's native
   **state encryption** turned on, so secrets in the state are never stored
   in clear text. The key provider and the storage account's own access rules
   are decided in `046`'s design.
3. CI authenticates to Azure only through GitHub Actions OIDC federated
   credentials (no stored client secret), and every `apply` waits for a
   human's approval in a GitHub environment. Plans run in CI; nothing is
   applied from a laptop or from an agent session.
4. Static checks (format, validate, lint and a policy scan) run in CI on
   every change to the IaC, as the other CI gates do.

## Consequences

- Tayzu must protect a state file, which Bicep would not have needed. Native
  state encryption and Entra-only access to the storage account are the
  controls, and `046` records them in `docs/security/secrets.md`.
- The `azurerm` provider can lag new Azure Container Apps API versions; the
  `azapi` provider covers the gap without changing tools.
- Terraform modules and examples remain usable, since OpenTofu reads the same
  HCL. Tayzu does not depend on HashiCorp's licence terms.
- The Terraform provider of `040-iac-provider` (for Tayzu's own resources) is
  unrelated to this choice; OpenTofu can run it.
