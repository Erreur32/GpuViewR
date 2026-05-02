# GitHub setup: security & quality workflows

This document describes the one-time setup required for the GpuViewR security
and quality workflows. **Open the matching settings page on github.com and
follow the steps below.**

All steps are **independent**: you can enable any subset. The workflows are
already committed; the only work left is configuring secrets and signing up
to the third-party services.

---

## 1. Dependabot (free, no account needed)

Dependabot is configured via [`.github/dependabot.yml`](dependabot.yml). It
will open pull requests for:

- npm dependencies: weekly Monday 06:00 Europe/Paris (minor + patch grouped)
- GitHub Actions: weekly Monday 06:30 Europe/Paris
- Docker base image (Node 22 Alpine): weekly Monday 06:45 Europe/Paris

### Enable security updates

1. Go to **Settings → Code security**
2. Enable **Dependabot alerts** ✅
3. Enable **Dependabot security updates** ✅
4. (Optional) Enable **Grouped security updates**

### If a security PR fails

Sometimes Dependabot can't resolve a security advisory because of a
transitive lock (e.g. a deep dependency pinning an older version). When that
happens, Dependabot reports `security_update_not_possible`. The fix is
usually to swap the offending top-level package for a maintained
alternative: see how `bcrypt` was replaced by `bcryptjs` in our history.

---

## 2. CodeQL (free, no account needed)

CodeQL runs from [`codeql.yml`](codeql.yml) on push, PR, and weekly schedule.
Results appear under **Security → Code scanning**.

No setup required. The first run after pushing creates the `code-scanning`
view automatically.

---

## 3. OpenSSF Scorecard (free, no account needed)

[`scorecard.yml`](scorecard.yml) publishes Scorecard results to
[scorecard.dev](https://scorecard.dev) and uploads the SARIF to the
**Security → Code scanning** tab.

### Enable

1. Go to **Settings → Code security**
2. (Recommended) Enable **branch protection** for `main` so the
   `Branch-Protection` check passes.
3. The first run uploads results; nothing else to do.

The Scorecard badge in the README links to the public dashboard.

---

## 4. Snyk (free for open-source)

[`snyk.yml`](snyk.yml) runs three scans on every push/PR:

- **Snyk Code** (SAST): TypeScript code patterns
- **Snyk Open Source**: npm dependency vulnerabilities (severity ≥ high)
- **Snyk Container**: Docker image scan (severity ≥ high, excluding base
  image vulns)

### Setup

1. Sign up at [snyk.io](https://snyk.io) (free tier)
2. Go to **Account settings → API token** → copy the token
3. On GitHub: **Settings → Secrets and variables → Actions →
   New repository secret**
   - Name: `SNYK_TOKEN`
   - Value: paste the token from Snyk
4. Push (or re-run the failed workflow): the Snyk badge in the README
   should turn green

The workflow uses `continue-on-error: true` everywhere, so a missing secret
won't break CI; the SARIF upload step simply skips when there's no result
file.

---

## 5. SonarCloud (free for open-source)

[`sonarcloud.yml`](sonarcloud.yml) + [`sonar-project.properties`](../../sonar-project.properties)
run a code-quality scan and publish the result to
[sonarcloud.io](https://sonarcloud.io).

### Setup

1. Sign in to SonarCloud with your GitHub account.
2. Click **+ → Analyze new project** → select `Erreur32/GpuViewR` →
   **Set up**.
3. Pick the **GitHub Actions** integration (recommended).
4. SonarCloud generates a `SONAR_TOKEN`. Copy it.
5. On GitHub: **Settings → Secrets and variables → Actions →
   New repository secret**
   - Name: `SONAR_TOKEN`
   - Value: paste the token from SonarCloud
6. (Optional) On the SonarCloud project page, **Administration →
   Analysis Method**, disable "Automatic Analysis" so the GitHub Actions
   run is the only source: avoids duplicate quality gate decisions.
7. Push: the SonarCloud quality-gate badge should appear green.

The `sonar.projectKey` is `Erreur32_GpuViewR` and the organization is
`erreur32`. Change them if you fork.

---

## Troubleshooting

### "GITHUB_TOKEN" permission errors on `docker-publish.yml`

- **Settings → Actions → General → Workflow permissions**
- Set to **Read and write permissions** ✅
- (Optional) Allow GitHub Actions to create / approve pull requests ✅

### A workflow is silent (no run shown)

GitHub disables scheduled workflows on inactive repos after 60 days. Push
once or trigger manually from the **Actions** tab to reactivate.

### A SARIF file fails to upload

The workflows guard the upload step with `if: always() && hashFiles(...)`.
If the SARIF was never produced (e.g. missing `SNYK_TOKEN`), the upload step
is silently skipped: that's the intended behavior.
