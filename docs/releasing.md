
# Stripe Checkout for EmDash — Release Guide

This document describes the release process for Stripe Checkout for EmDash, maintained by eCommerce Ave.

## Release Strategy

GitHub Actions is the preferred publishing method for all production releases.

The release workflow validates the source code, builds the plugin, generates signed build provenance, and submits the release to the EmDash Plugin Registry.

Manual publishing is available as a fallback, but it should not be used for normal production releases because it bypasses the GitHub Actions provenance workflow.

## Version Management

The plugin version is defined in `package.json`.

The `emdash-plugin.jsonc` manifest intentionally does not contain a version field.

Follow semantic versioning:

- Major: Breaking changes.
- Minor: New features, routes, or hooks.
- Patch: Bug fixes and compatible improvements.

Every published release must have a new, previously unpublished version.

Changes to manifest capabilities, allowed hosts, or storage require a version bump.

## Pre-Release Checklist

Before preparing a release:

1. Confirm the working tree is clean.
2. Review all changes since the previous release.
3. Update documentation for new or changed functionality.
4. Confirm the intended version in `package.json`.
5. Run the complete validation suite.
6. Confirm GitHub Actions CI passes.
7. Test installation or upgrading in a separate EmDash project.
8. Verify the plugin's administration interface and relevant storefront functionality.

### Local Validation

Run:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm build
```

All commands must complete successfully before publication.

## GitHub Actions Release Workflow

The publishing workflow is located at:

`.github/workflows/emdash-release.yml`

It performs the following operations:

1. Verifies that the GitHub repository is public.
2. Checks out the release source.
3. Installs dependencies using the lockfile.
4. Validates TypeScript.
5. Runs automated tests.
6. Builds the plugin and storefront integration.
7. Prepares the EmDash release bundle.
8. Creates signed GitHub build provenance.
9. Submits the release bundle and provenance to EmDash.

### Manual Workflow Trigger

For the initial v1.0.0 release, use the manual GitHub Actions workflow trigger.

1. Push the reviewed release changes to GitHub.
2. Confirm the CI workflow passes.
3. Open the repository's Actions tab.
4. Select **Publish EmDash plugins**.
5. Choose **Run workflow**.
6. Select the intended release branch or ref.
7. Enter the plugin ID in the package input.
8. Run the workflow.
9. Review the workflow logs and publication result.

Plugin ID:

```text
did:plc:wlshattmcjplayfxlgzbhxvk/emdash-stripe-checkout
```

Do not run the workflow until the release version and source code are finalized.

### Tag-Based Releases

The workflow also supports Git tags matching:

```text
*@*
```

The release selector supports a plugin ID and version.

Do not assume a conventional `v1.0.0` tag will trigger this workflow.

Confirm the exact selector and tag format before using automated tag-based publication.

## Signed Build Provenance

The release workflow uses GitHub's `actions/attest-build-provenance` action to generate provenance for the prepared plugin bundle.

The generated provenance bundle is passed to the EmDash release action.

A successful GitHub attestation does not, by itself, confirm that EmDash accepted and published the release with provenance.

Both the GitHub Actions result and the EmDash registry's verification information must be checked.

## Post-Release Verification

After publication:

1. Confirm the GitHub Actions release workflow succeeded.
2. Confirm the expected version appears in the EmDash Plugin Registry.
3. Verify that the publisher signature is valid.
4. Verify that build provenance is recognized by EmDash.
5. Install or upgrade the plugin in the separate release-test EmDash project.
6. Confirm the plugin loads and its settings are accessible.
7. Verify product synchronization, checkout, and webhook behavior in Stripe test mode as applicable.
8. Confirm storefront integration still works.
9. Record the release in the project changelog.

Plugin Registry:

https://plugins.emdashcms.com/plugins/@ecommerceave.com/emdash-stripe-checkout

## Release Conflicts

EmDash does not allow an existing package version to be replaced with a different release.

If a release fails with `RELEASE_CONFLICT`:

1. Stop the release process.
2. Confirm whether the version is already published.
3. Inspect the workflow logs.
4. Do not repeatedly submit a conflicting version.
5. Prepare a new version when another release is required.

## Manual Publishing Fallback

The repository retains the following commands:

```sh
pnpm run login -- ecommerceave.com
pnpm run publish
```

Use manual publishing only when there is a specific reason not to use the standard GitHub Actions release workflow.

A manually published release should not be assumed to contain GitHub build provenance.

## v1.0.0 Release Requirements

Before publishing v1.0.0, confirm:

- Multi-currency support is validated.
- Automated tests, TypeScript validation, and builds pass.
- README and storefront integration documentation are current.
- Release documentation is complete.
- The changelog is prepared.
- The separate EmDash release-test installation is ready for upgrade testing.
- The release version has not already been published.
- GitHub Actions publication is ready to be tested with signed provenance.

Do not publish v1.0.0 until these requirements have been reviewed.
