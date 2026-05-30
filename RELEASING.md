# Releasing

How code gets from your laptop to npm — and to a GitHub Release.

There is **one** release path. Follow it exactly and the pipeline does the rest.

---

## TL;DR

```bash
git checkout main && git pull            # 1. start from a clean, current main
npm ci && npm test && npm run build      # 2. prove it's green locally
$EDITOR CHANGELOG.md                     # 3. rename "## Unreleased" -> "## X.Y.Z — YYYY-MM-DD"
git commit -am "docs: changelog for vX.Y.Z"
npm version <patch|minor|major> -m "chore: release v%s"   # 4. bump + tag
git push --follow-tags                   # 5. push commit + tag -> CI does the rest
```

Step 5 triggers `release.yml`, which **publishes to npm** *and* **creates the GitHub Release**. You don't touch npmjs.com or the GitHub Releases page by hand.

---

## What happens automatically on a `v*` tag push

`.github/workflows/release.yml` runs on any pushed tag matching `v*`:

1. `npm ci`
2. `npm test`
3. `npm run build`
4. `npm publish --provenance --access public` — via **npm Trusted Publishing (OIDC)**, which attaches a provenance attestation linking the tarball to the exact commit + workflow run. No `NPM_TOKEN` secret involved.
5. **`gh release create`** — creates the GitHub Release for the tag, using the matching `## X.Y.Z` section of `CHANGELOG.md` as the release notes. If no matching section exists, it falls back to auto-generated notes.

Watch a run: <https://github.com/JustShift/webpack-to-vite/actions>.

> **Why you previously saw tags but no GitHub Releases:** the old workflow only published to npm and never created a Release. Step 5 above is the fix. A git *tag* and a GitHub *Release* are different objects — the tag is just a commit pointer; the Release is the page with notes that `gh release create` produces.

---

## Step-by-step release guide

### 1. Get on a clean, current `main`

```bash
git checkout main && git pull
git status                 # must be clean
```

Everything you want in the release is already merged to `main`. Releases are cut from `main`, never from a feature branch.

### 2. Verify locally

```bash
npm ci
npm test
npm run build
```

All green, or stop here and fix it first.

### 3. Update the changelog

Open `CHANGELOG.md`. Rename the top `## Unreleased` heading to the version and date you're about to release:

```md
## 0.2.1 — 2026-05-30
```

The release workflow extracts **exactly this section** (everything from `## 0.2.1` up to the next `## `) for the GitHub Release notes, so the heading must match the version you tag. Group entries by type (`feat` / `fix` / `docs` / `chore` / `ci`) when there are several.

Commit it on its own:

```bash
git commit -am "docs: changelog for v0.2.1"
```

### 4. Bump the version and tag

```bash
npm version patch -m "chore: release v%s"
```

This bumps `package.json` + `package-lock.json`, creates a `chore: release v0.2.1` commit, and creates an annotated `v0.2.1` tag — all in one step. Pick `patch` / `minor` / `major` per [Versioning](#versioning-semver).

### 5. Push the commit and tag together

```bash
git push --follow-tags
```

`--follow-tags` pushes both the release commit and the tag. The tag push triggers `release.yml` → npm publish + GitHub Release.

### 6. Confirm

- Actions run is green: <https://github.com/JustShift/webpack-to-vite/actions>
- npm shows the new version: `npm view @shiftkit/webpack-to-vite version`
- GitHub Release exists: <https://github.com/JustShift/webpack-to-vite/releases>

Then add a fresh `## Unreleased` heading back to the top of `CHANGELOG.md` for the next cycle (commit it whenever you next push).

---

## Versioning (semver)

| Bump | When |
|---|---|
| **patch** (`0.2.0 → 0.2.1`) | Bug fix, doc tweak, internal refactor. No new capability for callers. |
| **minor** (`0.2.0 → 0.3.0`) | New feature, new mapped Jest field, new CLI flag. Backwards compatible. |
| **major** (`0.2.0 → 1.0.0`) | Breaking change to the API or CLI: removed export, renamed option, changed output shape. |

Pre-1.0, a minor bump may include a breaking change if necessary — call it out **loudly** at the top of the changelog section when it does.

---

## Branching

Trunk-based. One long-lived branch (`main`); short-lived branches off it for everything else.

| Branch prefix | Purpose |
|---|---|
| `feat/*` | New features |
| `fix/*` | Bug fixes |
| `chore/*` | Tooling, deps, infra |
| `docs/*` | Docs only |

Rules:

- Branch from `main`, PR back into `main`. Every commit on `main` should pass CI.
- One concern per branch; split unrelated changes.
- Squash- or rebase-merge to keep history linear. Delete the branch after merge.
- **Do not** cut releases from a `release/*` branch. The release commit (`npm version`) lands directly on `main` — that is the documented path, and it keeps tags pointing at real release commits instead of merge commits.

Commit messages: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `refactor:`, `test:`). The prefix is the changelog signal.

---

## Hotfix flow

A bug in the latest release is blocking users:

```bash
git checkout main && git pull
git checkout -b fix/short-description
# ...fix + add a regression test...
git commit -am "fix: <description>"
git push -u origin fix/short-description
# open PR, merge to main
```

Then run the standard [step-by-step guide](#step-by-step-release-guide) with `npm version patch`.

If `main` has unreleasable in-progress work, branch the hotfix off the last release tag instead, release from there, then merge the fix back into `main`:

```bash
git checkout -b fix/urgent v0.2.0
# ...fix, changelog, npm version patch -> v0.2.1, push --follow-tags...
git checkout main && git merge fix/urgent   # or cherry-pick
```

---

## Pre-release / canary versions

For testing in-progress changes without moving the `latest` tag:

```bash
npm version prerelease --preid=canary -m "chore: release v%s"   # 0.2.1 -> 0.2.2-canary.0
git push --follow-tags
```

**Heads up:** `npm publish` tags the release as `latest` *regardless* of the semver pre-release suffix unless you pass `--tag`. So as written today, publishing a `v0.2.2-canary.0` tag would still move `latest`. Before you rely on canaries, make the publish step in `release.yml` conditional:

```yaml
- run: |
    if [[ "${GITHUB_REF_NAME}" == *-* ]]; then
      npm publish --provenance --access public --tag canary
    else
      npm publish --provenance --access public
    fi
```

Users install pre-releases with `npm install @shiftkit/webpack-to-vite@canary`.

---

## Rolling back

npm severely restricts unpublishing. If a release is broken:

1. **First 72 hours, no dependents:** `npm unpublish @shiftkit/webpack-to-vite@<version>` — last resort; it fragments the version timeline.
2. **Otherwise — deprecate, don't unpublish:**
   ```bash
   npm deprecate @shiftkit/webpack-to-vite@0.2.1 "Critical bug; use 0.2.2 instead"
   ```
   Then ship a `0.2.2` patch with the fix.

Deprecation warns on install but doesn't break existing lockfiles. It's the right tool 99% of the time.

---

## What CI runs

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Push to `main`, or any PR | `npm run lint` (typechecks `src/` **and** `tests/`) + `npm test` on Node 20 & 22 + `npm run build` |
| `release.yml` | Push of a `v*` tag | Tests + build + `npm publish --provenance` (OIDC) on Node 24, then creates the GitHub Release |

If `ci.yml` fails on a PR, don't merge. If `release.yml` fails, the tag exists but no publish happened — investigate the run, push a fix, then bump to the **next** patch and re-tag (do **not** reuse a failed tag).

---

## Gotchas (hard-won lessons — don't reintroduce)

### Use Node 24+ in `release.yml`, not in `ci.yml`
OIDC trusted publishing requires npm ≥ 11.5.1. Node 22 ships npm 10.x; Node 24 ships npm 11+. The release workflow is pinned to Node 24 for this reason. `ci.yml` stays on Node 20 & 22 for broader **consumer** compatibility (the package supports Node ≥ 20).

### Don't run `npm install -g npm@latest` in GitHub Actions
There's a long-standing npm self-upgrade corruption bug on hosted runners (it deletes `promise-retry` mid-install and dies with `MODULE_NOT_FOUND`). Bump the Node version instead.

### Always pass `--provenance` to `npm publish`
npm docs claim provenance is automatic with trusted publishing, but in practice the CLI sometimes doesn't request the OIDC token unless `--provenance` is explicit. Without it the publish silently falls back to anonymous and fails with a confusing `404 Not Found`.

### Don't set `NODE_AUTH_TOKEN` on the publish step
`actions/setup-node@v4` with `registry-url` already wires up `_authToken` in `.npmrc`. Setting `NODE_AUTH_TOKEN` (even empty) breaks OIDC because npm tries to use that token instead of requesting an OIDC one. Leave the env block off the publish step entirely.

### The changelog heading must match the tag
The Release step extracts the `## X.Y.Z` section from `CHANGELOG.md`. If you forget to rename `## Unreleased` to the version, the Release still gets created — but with auto-generated notes instead of your curated ones.

### Failed-tag housekeeping
If a tag fails to publish, bump to the next patch rather than re-tagging the same version (re-tagging needs force-pushed tags — messy in `git log`). To prune an orphan tag:

```bash
git tag -d v0.2.1
git push origin :refs/tags/v0.2.1
```

---

## First-time setup checklist (new maintainers)

- [ ] Clone the repo, `npm install`, `npm test` (all green)
- [ ] Read `CONTRIBUTING.md` and this file
- [ ] If you'll publish: ensure your GitHub account is in the `JustShift` org with write access. Trusted Publishing handles npm auth — **no npm token needed**.
- [ ] Confirm npm Trusted Publishing is configured once on npmjs.com → `@shiftkit/webpack-to-vite` → Settings → Trusted Publishing → GitHub Actions → repo `JustShift/webpack-to-vite`, workflow `release.yml`.
