# ForgeGate Security Guide & Local Audit Workflow

ForgeGate takes security seriously across dependencies, application source code, secrets management, and container images. This document outlines the automated security controls in CI and provides instructions for developers to run security audits locally.

---

## 1. Local Developer Security Commands

Developers should perform local security verification before submitting pull requests.

### A. Dependency Vulnerability Audit
Run the automated dependency audit script:
```bash
pnpm run audit
```
Or specify custom severity levels:
```bash
pnpm audit --audit-level high
```
*Transitive patches*: If a transitive dependency has a known vulnerability, override it cleanly in `pnpm-workspace.yaml` under `overrides:` (e.g., `tar: "^7.5.21"`). Do not perform major version upgrades unless verified.

### B. Local Secret Scanning
To scan your local git repository and staged commits for accidentally hardcoded secrets (API keys, JWTs, private keys, credentials):
```bash
# Install Gitleaks (CLI)
# macOS: brew install gitleaks
# Linux: curl -sSFL https://github.com/zricethezav/gitleaks/releases/latest/download/gitleaks_linux_x64.tar.gz | tar -xz

# Detect hardcoded secrets locally
gitleaks detect --verbose
```

### C. Local Docker Container Image Scan
To audit built Docker images for OS and library vulnerabilities:
```bash
# Build the image locally
docker build -t forgegate-app:local .

# Audit with Trivy CLI
# macOS: brew install trivy
# Linux: apt-get install trivy (or via curl)
trivy image --severity HIGH,CRITICAL forgegate-app:local
```

---

## 2. Automated CI Security Controls

ForgeGate CI executes the following security workflows on every `push` and `pull_request` to `main`, `master`, or `dev`:

1. **Dependency Audit Job**: Executes `pnpm run audit` (`--audit-level high`) in `.github/workflows/security.yml`.
2. **Secret & Credential Scanning Job**: Runs `gitleaks/gitleaks-action` across full Git history. Secret values are masked and never exposed in CI logs.
3. **Static Application Security Testing (SAST)**: Executes GitHub CodeQL (`.github/workflows/codeql.yml`) for `javascript-typescript`.
4. **Container Image Scanning**: Runs `aquasecurity/trivy-action` on built Docker images (`forgegate-app` and `forgegate-api-gateway`).
5. **Dependabot Updates**: Weekly checks configured via `.github/dependabot.yml`. Dependabot is explicitly restricted from making semver `major` version upgrades to prevent breaking changes.

---

## 3. Secret Management Guidelines

- **Environment Variables**: Use `.env.example` as a reference template. Never commit real secrets, private keys, DB credentials, or API keys to repository files.
- **CI Secrets**: Store deployment and integration credentials strictly in GitHub Repository Secrets.
- **Log Masking**: Ensure structured loggers mask or truncate tokens, authorization headers, and API keys.

---

## 4. Reporting Vulnerabilities

If you discover a potential security vulnerability in ForgeGate, please do not open a public issue. Report the security concern responsibly via email or security disclosure form.
