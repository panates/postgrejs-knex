#!/usr/bin/env bash
#
# Runs Knex's own test suite against this client.
#
# Knex's suite has a postgres variant that normally runs on its built-in
# `pg` client. This checks Knex out at a known version, points that
# variant at knex-postgrejs instead (scripts/knex-suite.patch), and runs
# the whole thing - every test Knex holds its own client to.
#
# Everything lands in $WORK_DIR; nothing outside this repository is
# modified. The database is Knex's own docker-compose service, on port
# 25432, so a local PostgreSQL is left alone. It is left running at the
# end - stop it, and drop its data, with:
#
#   docker compose -p "$COMPOSE_PROJECT" -f "$WORK_DIR/knex/scripts/docker-compose.yml" down -v
#
# Usage: scripts/run-knex-suite.sh
#   KNEX_VERSION       git tag to test against  (default: 3.3.0)
#   WORK_DIR           where the checkout lives (default: $TMPDIR/knex-postgrejs-suite)
#   EXPECTED_FAILURES  when set, succeed only if exactly this many tests
#                      fail - the failures Knex's suite has against this
#                      client are known and listed in the README, so what
#                      matters in CI is whether that number moved
set -euo pipefail

KNEX_VERSION="${KNEX_VERSION:-3.3.0}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${WORK_DIR:-${TMPDIR:-/tmp}/knex-postgrejs-suite}"
KNEX_DIR="$WORK_DIR/knex"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Knex $KNEX_VERSION in $KNEX_DIR"
mkdir -p "$WORK_DIR"
if [ ! -d "$KNEX_DIR/.git" ]; then
  git clone --filter=blob:none https://github.com/knex/knex.git "$KNEX_DIR"
fi
git -C "$KNEX_DIR" fetch --tags --quiet
# Drop a patch left by an earlier run before moving the checkout.
git -C "$KNEX_DIR" checkout --quiet -- test
git -C "$KNEX_DIR" checkout --quiet "$KNEX_VERSION"

# A compose project of its own per Knex version, because the server's data
# lives in a volume that the project name decides. Knex 3.0's compose runs
# PostgreSQL 13 and 3.3's runs 17, so sharing one project leaves the older
# server refusing to start on the newer one's data directory - "database
# files are incompatible with server", after a recreate that looks like it
# worked.
COMPOSE_PROJECT="knexsuite-$(printf '%s' "$KNEX_VERSION" | tr -c 'a-z0-9' '-')"

# Knex's compose file hard-codes port 25432, so only one version's database
# can listen at a time however the projects are named. A container left
# running by another version's run is stopped rather than left to fail the
# bind; its data stays in its own volume, so that version runs again without
# reinitialising.
for leftover in $(docker ps --filter "publish=25432" --format '{{.Names}}' 2>/dev/null); do
  case "$leftover" in
    "$COMPOSE_PROJECT"-*) ;;
    *)
      say "Stopping $leftover, which holds port 25432"
      docker stop "$leftover" >/dev/null
      ;;
  esac
done

say "Starting Knex's own PostgreSQL (port 25432), project $COMPOSE_PROJECT"
COMPOSE=(docker compose -p "$COMPOSE_PROJECT" -f "$KNEX_DIR/scripts/docker-compose.yml")
# The port is read from the compose file rather than asked of compose,
# which answered "0.0.0.0:0" for a container it had only just started and
# sent the readiness loop to a port nothing listens on.
PG_HOST_PORT=25432

wait_for_postgres() {
  local _
  for _ in $(seq 1 60); do
    nc -z 127.0.0.1 "$PG_HOST_PORT" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

"${COMPOSE[@]}" up -d postgres
# A container left over from a run that could not bind the port keeps
# running with no published port at all, and then nothing on the host can
# reach it - recreate it rather than let the suite wait for a timeout.
if ! wait_for_postgres; then
  say "Nothing answering on $PG_HOST_PORT, recreating the container"
  "${COMPOSE[@]}" up -d --force-recreate postgres
  wait_for_postgres ||
    {
      echo "postgres did not start listening on 127.0.0.1:$PG_HOST_PORT" >&2
      exit 1
    }
fi

# Install scripts have to run: Knex's suite loads its sqlite specs whatever
# DB is set, and an unbuilt sqlite3 takes the whole run down before a single
# postgres test has started.
say "Installing Knex's own dependencies"
(cd "$KNEX_DIR" && npm install --no-audit --no-fund)

say "Building this client"
(cd "$REPO_DIR" && npx rman build)

say "Pointing the postgres variant at this client"
git -C "$KNEX_DIR" apply "$REPO_DIR/scripts/knex-suite.patch"

# The client is installed as a real directory rather than a link: Node
# resolves a linked package's own imports from the link's target, and
# `knex` has to come out as the checkout the suite itself runs on - two
# copies of it would mean the suite testing one and the client extending
# another.
DEST="$KNEX_DIR/node_modules/knex-postgrejs"
rm -rf "$DEST"
mkdir -p "$DEST/node_modules"
cp -R "$REPO_DIR/build/." "$DEST/"
ln -sfn "$KNEX_DIR" "$DEST/node_modules/knex"
ln -sfn "$REPO_DIR/node_modules/postgrejs" "$DEST/node_modules/postgrejs"
ln -sfn "$REPO_DIR/node_modules/postgrejs" "$KNEX_DIR/node_modules/postgrejs"

# The sqlite dialect specs build a sqlite Knex while mocha is still loading
# files, whatever DB is set to - so an unbuildable `better-sqlite3` fails
# nine tests that have nothing to do with this client, and an unbuilt
# `sqlite3` takes the whole run down before a postgres test has started.
# They are another dialect's tests either way. SUITE_IGNORE replaces the
# list.
IGNORE=(
  --ignore 'test/integration2/dialects/sqlite.spec.js'
  --ignore 'test/integration2/dialects/better-sqlite3.spec.js'
)
if [ -n "${SUITE_IGNORE:-}" ]; then
  read -r -a IGNORE <<< "$SUITE_IGNORE"
fi

say "Running the suite"
cd "$KNEX_DIR"
set +e
DB=postgres npm run test:db -- "${IGNORE[@]}" 2>&1 | tee "$WORK_DIR/suite.log"
status=${PIPESTATUS[0]}
set -e

passing="$(sed -n 's/^ *\([0-9][0-9]*\) passing.*/\1/p' "$WORK_DIR/suite.log" | tail -1)"
# A run that fell over before any test started reports no counts at all, and
# mocha can still exit 0 for it - which would read as a pass.
if [ -z "$passing" ]; then
  echo "The suite reported no test counts: it did not get as far as running." >&2
  exit 1
fi

if [ -z "${EXPECTED_FAILURES:-}" ]; then
  exit "$status"
fi

failing="$(sed -n 's/^ *\([0-9][0-9]*\) failing.*/\1/p' "$WORK_DIR/suite.log" | tail -1)"
failing="${failing:-0}"
say "$passing passing, $failing failing, $EXPECTED_FAILURES expected"
if [ "$failing" != "$EXPECTED_FAILURES" ]; then
  echo "The set of failures moved. Go through them and update both the" >&2
  echo "README table and EXPECTED_FAILURES, or fix what regressed." >&2
  exit 1
fi
