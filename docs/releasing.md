# Releasing

Releases are made from an immutable Git tag after the production deployment and
the packed npm artifact have both been verified.

## One-time setup

1. Make the GitHub repository public before the first public npm release.
2. Create the `@forevermoney` npm organization and grant the maintainers release
   access.
3. On npm, configure a GitHub Actions trusted publisher for
   `ForeverMoney-Ai/forevermoney-sdk`, workflow `publish.yml`, environment
   `npm`.
4. In GitHub, create the `npm` environment and restrict deployment to protected
   tags matching `v*`.
5. Enable GitHub private vulnerability reporting and protect the default branch
   with the `Verify (Node 22)` and `Verify (Node 24)` checks.
6. Optionally add `BASE_RPC_URL` and `SUBTENSOR_RPC_URL` secrets to the
   `production-fork` environment. The workflow otherwise uses the public Base
   and Subtensor RPC endpoints for its read-only production checks.

The publish workflow uses npm trusted publishing. Do not add a long-lived npm
write token to the repository.

## Release checklist

1. Confirm every address and selector in `foreverMoneyDeployment` with the
   protocol deployer and the live contracts.
2. Start from a clean checkout and run `npm ci`, `npm run verify`,
   `npm audit --omit=dev`, and `npm run pack:dry-run`.
3. Run the `Production forks` GitHub workflow and retain the successful run.
4. Install the generated tarball into clean ESM, CommonJS, and TypeScript
   consumers. Test the same tarball in the ForeverMoney application.
5. Run the guarded real-key canary in both bridge directions with dedicated,
   low-balance wallets. Record source transaction hashes, CCIP message IDs,
   destination receipts, received principal, paid fees, and residual approvals.
6. Update `CHANGELOG.md` and the package version. Commit the release, then create
   and push an annotated `v<version>` tag.
7. Create a GitHub Release for that exact tag. Publishing the release triggers
   `.github/workflows/publish.yml`; its tag check must pass before npm receives
   the package.
8. Install `@forevermoney/sdk@<version>` from npm in a clean project and compare
   its package integrity with the workflow output.

Never reuse a treasury, founder, deployer, keeper, or user wallet for the
canary. Never publish from a dirty working tree or directly from an untagged
local directory.
