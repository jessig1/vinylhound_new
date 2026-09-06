# Security policy

## Supported versions

VinylHound is pre-1.0 software. Security fixes are applied to the latest commit
on `main`; older commits and deployments are not supported.

## Reporting a vulnerability

Do not open a public issue or Discussion for a suspected vulnerability.

Use GitHub's private vulnerability reporting from the repository's **Security**
tab. Include affected components, reproduction steps, impact, and any proposed
mitigation. Avoid accessing other users' data, running denial-of-service tests,
or incurring provider costs while investigating.

The maintainer will aim to acknowledge a report within three business days,
provide an initial assessment within seven business days, and coordinate
disclosure after a fix is available. These are response targets, not a bug
bounty or service-level agreement.

If private vulnerability reporting is temporarily unavailable, contact the
maintainer using the private contact information on
[@jessig1's GitHub profile](https://github.com/jessig1).

## Secrets and personal data

If a credential or personal-data artifact appears in Git history, report it
privately even if it has since been removed. Deleting a file from the current
branch does not invalidate a secret or remove it from history.
