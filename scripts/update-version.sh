#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Bump GpuViewR version across the repo (run from project root or anywhere).
# Usage:   ./scripts/update-version.sh <new_version>
#          ./scripts/update-version.sh <new_version> --tag-push
#
# Updated files:
#   1. package.json                           : "version" field
#   2. package-lock.json                      : root + packages."".version
#   3. src/components/layout/Header.tsx       : VERSION constant
#   4. README.md                              : GpuViewR-vX.Y.Z badges & links
#
# Commit message file (should be edited before committing):
#      commit-message.txt: used by git commit -F commit-message.txt
#
# Options:
#   --tag-push   After bump, commit using commit-message.txt, create tag, push branch & tag.
#
# After running (without --tag-push):
#   1. Edit commit-message.txt with the actual changes for this version.
#   2. Add a new entry in CHANGELOG.md for this version.
#   3. git add -A && git commit -F commit-message.txt && git push
#   4. git tag v<NEW> && git push origin v<NEW>
# ──────────────────────────────────────────────────────────────────────────────

set -e

# ── ANSI colors (disable if not a TTY) ───────────────────────────────────────
if [ -t 1 ]; then
  R="\033[0m"
  B="\033[1m"
  G="\033[32m"
  Y="\033[33m"
  C="\033[36m"
  M="\033[35m"
  RED="\033[31m"
else
  R="" B="" G="" Y="" C="" M="" RED=""
fi

# ── Resolve repo root (script lives in scripts/) ────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ── Target files ─────────────────────────────────────────────────────────────
PACKAGE_JSON="$REPO_ROOT/package.json"
PACKAGE_LOCK="$REPO_ROOT/package-lock.json"
HEADER_TSX="$REPO_ROOT/src/components/layout/Header.tsx"
ROOT_README="$REPO_ROOT/README.md"
SONAR_PROPS="$REPO_ROOT/sonar-project.properties"
COMMIT_MSG_FILE="$REPO_ROOT/commit-message.txt"

# ── Read current version from package.json ────────────────────────────────────
if [ ! -f "$PACKAGE_JSON" ]; then
  echo -e "${RED}Error:${R} package.json not found at $PACKAGE_JSON"
  exit 1
fi

CURRENT=$(grep -E '"version":' "$PACKAGE_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
if [ -z "$CURRENT" ]; then
  echo -e "${RED}Error:${R} could not read current version from package.json"
  exit 1
fi

# ── Argument: new version + optional --tag-push ───────────────────────────────
NEW=""
TAG_PUSH=""
for arg in "$@"; do
  if [ "$arg" = "--tag-push" ]; then
    TAG_PUSH="1"
  elif [ -z "$NEW" ]; then
    NEW="$arg"
  fi
done

if [ -z "$NEW" ]; then
  SUGGESTED=$(echo "$CURRENT" | awk -F. '{$NF=$NF+1; print $0}' OFS=.)
  echo ""
  echo -e "  ${B}Current version:${R} ${C}${CURRENT}${R}"
  echo ""
  echo "  Usage: $0 <new_version> [--tag-push]"
  echo ""
  echo "  Examples:"
  echo -e "    ${C}$0 ${SUGGESTED}${R}              # bump version only"
  echo -e "    ${C}$0 ${SUGGESTED} --tag-push${R}   # bump + commit + tag + push"
  echo ""
  exit 0
fi

# ── Sanity check: new != current (unless --tag-push only) ────────────────────
if [ "$NEW" = "$CURRENT" ]; then
  if [ -n "$TAG_PUSH" ]; then
    echo ""
    echo -e "${M}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}"
    echo -e "${M}${B}  Tag and push v$NEW (version already set)${R}"
    echo -e "${M}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}"
    echo ""
  else
    echo -e "${Y}Warning:${R} new version ($NEW) is the same as current ($CURRENT). Nothing to do."
    exit 0
  fi
fi

# ── Helper: sed in-place (portable macOS / Linux) ───────────────────────────
sedi() {
  local file="$1"; shift
  sed -i.bak "$@" "$file" && rm -f "${file}.bak"
}

# ── Generic semver pattern for sed ──────────────────────────────────────────
SEMVER_PATTERN='[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*'
CURRENT_ESC=$(echo "$CURRENT" | sed 's/\./\\./g')

# ═════════════════════════════════════════════════════════════════════════════
#  VERSION UPDATES: skip if version already matches
# ═════════════════════════════════════════════════════════════════════════════

if [ "$NEW" != "$CURRENT" ]; then

echo ""
echo -e "${M}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}"
echo -e "${M}${B}  Bump GpuViewR version: $CURRENT → $NEW${R}"
echo -e "${M}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}"
echo ""
echo -e "  ${B}── Version bump ──${R}"

# ── 1. package.json ─────────────────────────────────────────────────────────
if [ -f "$PACKAGE_JSON" ]; then
  sedi "$PACKAGE_JSON" "s/\"version\": \"$CURRENT_ESC\"/\"version\": \"$NEW\"/"
  echo -e "  ${G}✓${R} package.json                       ${C}(\"version\": \"$NEW\")${R}"
else
  echo -e "  ${RED}✗${R} package.json                       ${RED}(file not found)${R}"
fi

# ── 2. package-lock.json (root + packages.""."version") ─────────────────────
if [ -f "$PACKAGE_LOCK" ]; then
  sedi "$PACKAGE_LOCK" "0,/\"version\": \"$CURRENT_ESC\"/s/\"version\": \"$CURRENT_ESC\"/\"version\": \"$NEW\"/"
  sedi "$PACKAGE_LOCK" "s/\"version\": \"$CURRENT_ESC\"/\"version\": \"$NEW\"/"
  echo -e "  ${G}✓${R} package-lock.json                  ${C}(root + packages.\"\".version)${R}"
else
  echo -e "  ${Y}○${R} package-lock.json                  ${Y}(not found, run npm install later)${R}"
fi

# ── 3. src/components/layout/Header.tsx: VERSION constant ──────────────────
if [ -f "$HEADER_TSX" ]; then
  sedi "$HEADER_TSX" "s/const VERSION = 'v${SEMVER_PATTERN}';/const VERSION = 'v$NEW';/"
  echo -e "  ${G}✓${R} src/components/layout/Header.tsx   ${C}(VERSION = 'v$NEW')${R}"
else
  echo -e "  ${RED}✗${R} src/components/layout/Header.tsx   ${RED}(file not found)${R}"
fi

# ── 4. README.md: release links + version text ────────────────────────────
# Note: the static "GpuViewR-vX.Y.Z" badge has been removed from the README;
# the dynamic GitHub Release badge updates itself, so we no longer rewrite it.
if [ -f "$ROOT_README" ]; then
  # releases/tag/vX.Y.Z
  sedi "$ROOT_README" "s|releases/tag/v${SEMVER_PATTERN}|releases/tag/v$NEW|g"
  # Backtick-quoted current semver (only the current version, to avoid wide replace)
  sedi "$ROOT_README" "s/\`$CURRENT_ESC\`/\`$NEW\`/g"
  echo -e "  ${G}✓${R} README.md                          ${C}(release links + version text)${R}"
else
  echo -e "  ${RED}✗${R} README.md                          ${RED}(file not found)${R}"
fi

# ── 5. sonar-project.properties: projectVersion ────────────────────────────
if [ -f "$SONAR_PROPS" ]; then
  sedi "$SONAR_PROPS" "s/sonar\.projectVersion=.*/sonar.projectVersion=$NEW/"
  echo -e "  ${G}✓${R} sonar-project.properties           ${C}(sonar.projectVersion=$NEW)${R}"
else
  echo -e "  ${Y}○${R} sonar-project.properties           ${Y}(not found, skipped)${R}"
fi

# ── commit-message.txt: show status ────────────────────────────────────────
echo ""
echo -e "  ${B}── Commit message file ──${R}"
if [ -f "$COMMIT_MSG_FILE" ]; then
  if grep -q "v${NEW}" "$COMMIT_MSG_FILE" 2>/dev/null; then
    echo -e "  ${G}✓${R} commit-message.txt       ${C}(already contains v${NEW}: ready to use)${R}"
  else
    echo -e "  ${Y}⚠${R} commit-message.txt       ${Y}(exists but does NOT mention v${NEW}: update it!)${R}"
  fi
else
  cat > "$COMMIT_MSG_FILE" << CMEOF
release: v${NEW}

- <change 1>
- <change 2>
CMEOF
  echo -e "  ${G}✓${R} commit-message.txt       ${C}(generated template: edit before committing)${R}"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${G}${B}Done.${R} GpuViewR version is now ${B}$NEW${R}."
echo ""
echo -e "  ${B}── Files to commit (do NOT forget these!) ──${R}"
echo -e "  ${C}  package.json${R}"
echo -e "  ${C}  package-lock.json${R}  (if updated)"
echo -e "  ${C}  src/components/layout/Header.tsx${R}"
echo -e "  ${C}  README.md${R}"
echo -e "  ${C}  sonar-project.properties${R}"
echo -e "  ${C}  CHANGELOG.md${R}"
echo ""
echo -e "  ${Y}⚠${R}  Use ${B}git add -A${R} to stage ALL updated files."

fi  # end of "if NEW != CURRENT"

# ═════════════════════════════════════════════════════════════════════════════
#  TAG + PUSH (--tag-push)
# ═════════════════════════════════════════════════════════════════════════════

do_commit_tag_push() {
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [ -z "$branch" ]; then
    echo -e "${RED}Error:${R} not a git repository or no branch. Cannot tag/push."
    return 1
  fi

  local tag_name="v$NEW"

  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo -e "  ${B}Uncommitted changes found: committing...${R}"
    git add -A

    if [ -f "$COMMIT_MSG_FILE" ] && grep -q "v${NEW}\|${NEW}" "$COMMIT_MSG_FILE" 2>/dev/null; then
      git commit -F "$COMMIT_MSG_FILE" || { echo -e "${RED}Commit failed.${R}"; return 1; }
      echo -e "  ${G}✓${R} Committed using ${C}commit-message.txt${R}"
    else
      git commit -m "release: v$NEW" || { echo -e "${RED}Commit failed.${R}"; return 1; }
      echo -e "  ${G}✓${R} Committed with generic message ${C}\"release: v$NEW\"${R}"
      echo -e "  ${Y}⚠${R} ${Y}commit-message.txt was missing or outdated: used fallback message${R}"
    fi
    echo ""
  else
    echo -e "  ${G}✓${R} Working tree clean: no commit needed."
    echo ""
  fi

  if git rev-parse "$tag_name" >/dev/null 2>&1; then
    echo -e "  ${Y}⚠${R} Tag ${C}${tag_name}${R} already exists locally."
  else
    git tag -a "$tag_name" -m "Release $tag_name" || { echo -e "${RED}Tag creation failed.${R}"; return 1; }
    echo -e "  ${G}✓${R} Tag ${C}${tag_name}${R} created."
  fi

  echo -e "  ${B}Pushing ${C}origin ${branch}${R} ...${R}"
  if ! git push origin "$branch"; then
    echo -e "${RED}Push branch failed.${R}"
    return 1
  fi
  echo -e "  ${G}✓${R} Branch ${C}${branch}${R} pushed."

  if git ls-remote origin "refs/tags/$tag_name" 2>/dev/null | grep -q .; then
    echo -e "  ${Y}○${R} Tag ${C}${tag_name}${R} already exists on remote: skip."
  else
    echo -e "  ${B}Pushing tag ${C}${tag_name}${R} ...${R}"
    if ! git push origin "$tag_name"; then
      echo -e "${RED}Push tag failed.${R}"
      return 1
    fi
    echo -e "  ${G}✓${R} Tag ${C}${tag_name}${R} pushed."
  fi
  echo ""
  echo -e "  ${G}✓${R} Done."
  return 0
}

if [ -n "$TAG_PUSH" ]; then
  echo ""
  echo -e "${C}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}"
  echo -e "${C}${B}  Commit, tag and push (--tag-push)${R}"
  echo -e "${C}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}"
  echo ""
  do_commit_tag_push || exit 1
  echo ""
  exit 0
fi

# ═════════════════════════════════════════════════════════════════════════════
#  MANUAL COMMANDS (when --tag-push is not used)
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${Y}→${R} Edit ${B}commit-message.txt${R} with the actual changes for v${NEW}."
echo -e "${Y}→${R} Add a new section in ${B}CHANGELOG.md${R} for this version."
echo ""
echo -e "${C}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}"
echo -e "${C}${B}  Commands to run (copy / paste)${R}"
echo -e "${C}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}"
echo ""
echo -e "  ${B}1. Commit with commit-message.txt:${R}"
echo -e "     ${G}git add -A && git commit -F commit-message.txt && git push${R}"
echo ""
echo -e "  ${B}2. Create tag and push tag:${R}"
echo -e "     ${G}git tag -a v$NEW -m \"Release v$NEW\" && git push origin v$NEW${R}"
echo ""
echo -e "  ${B}All-in-one (commit + tag + push):${R}"
echo -e "     ${G}git add -A && git commit -F commit-message.txt && git tag -a v$NEW -m \"Release v$NEW\" && git push origin \$(git rev-parse --abbrev-ref HEAD) && git push origin v$NEW${R}"
echo ""
echo -e "  ${B}Or re-run with --tag-push (automatic):${R}"
echo -e "     ${C}$0 $NEW --tag-push${R}"
echo ""
