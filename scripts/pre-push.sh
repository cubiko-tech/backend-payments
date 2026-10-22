#!/usr/bin/env bash
# Validates pre-push gates in backend-payments: branch name (P4 or line/<name> P3),
# required CI files, full ESLint check without --fix, tsc --noEmit, and npm test.
set -euo pipefail

if [[ ! -f /.dockerenv && -z ${PRE_PUSH_IN_CONTAINER:-} && -f scripts/in-container.sh ]]; then
	PRE_PUSH_IN_CONTAINER=1 exec bash scripts/in-container.sh bash scripts/pre-push.sh "$@"
fi

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr -d '\r\n' || true)
line_re='^line/[a-z0-9]+(-[a-z0-9]+)*$'
p4_re='^(feat|fix|refactor|perf|build|ci|docs|chore|test|hotfix)/RXDEV-[0-9]+-[a-z0-9]+(-[a-z0-9]+)*$'

if [[ $branch =~ $line_re ]]; then
	:
elif [[ $branch =~ $p4_re ]] && ((${#branch} <= 60)); then
	:
else
	echo "pre-push: invalid branch '$branch'." >&2
	echo "  Expected P4 shape <tipo>/<CLAVE>-<desc> (<type>/RXDEV-<n>-<kebab-desc>, max 60 chars)" >&2
	echo "  Allowed types: feat, fix, refactor, perf, build, ci, docs, chore, test, hotfix" >&2
	echo "  Or P3 line branch: line/<nombre> (e.g. line/payments)" >&2
	exit 1
fi

required_files=(.env-template .env.schema docker-compose.yml entrypoint.sh)
for file in "${required_files[@]}"; do
	if [[ ! -f $file ]]; then
		echo "pre-push: required file missing: $file" >&2
		exit 1
	fi
done

eslint_bin="eslint"
if [[ -x ./node_modules/.bin/eslint ]]; then
	eslint_bin="./node_modules/.bin/eslint"
fi
"$eslint_bin" "{src,apps,libs,test}/**/*.ts" </dev/null || exit 1

tsc_bin="tsc"
if [[ -x ./node_modules/.bin/tsc ]]; then
	tsc_bin="./node_modules/.bin/tsc"
fi
"$tsc_bin" --noEmit </dev/null || exit 1

npm test -- --maxWorkers=2 </dev/null || exit 1
