#!/usr/bin/env bash
# Validates pre-push gates in backend-payments: reads pushed refs from stdin, skips deleted refs,
# and checks required CI files, full ESLint without --fix, tsc --noEmit, and npm test against
# the pushed commit tree rather than HEAD or the working tree.
set -euo pipefail

if [[ ! -f /.dockerenv && -z ${PRE_PUSH_IN_CONTAINER:-} && -f scripts/in-container.sh ]]; then
	PRE_PUSH_IN_CONTAINER=1 exec bash scripts/in-container.sh bash scripts/pre-push.sh "$@"
fi

pushed_shas=()
while read -r local_ref local_sha remote_ref remote_sha || [[ -n ${local_ref:-} ]]; do
	remote_sha=${remote_sha%$'\r'}
	remote_ref=${remote_ref%$'\r'}
	local_sha=${local_sha%$'\r'}
	local_ref=${local_ref%$'\r'}

	if [[ -z ${local_ref:-} ]]; then
		continue
	fi

	if [[ $local_ref == "(delete)" || $local_sha =~ ^0+$ || -z ${remote_ref:-} || $remote_ref == "(delete)" ]]; then
		continue
	fi

	already_queued=0
	for existing_sha in "${pushed_shas[@]+"${pushed_shas[@]}"}"; do
		if [[ $existing_sha == "$local_sha" ]]; then
			already_queued=1
			break
		fi
	done
	if ((already_queued == 0)); then
		pushed_shas+=("$local_sha")
	fi
done

if ((${#pushed_shas[@]} == 0)); then
	exit 0
fi

repo_root="$PWD"
eslint_bin="eslint"
if [[ -x "$repo_root/node_modules/.bin/eslint" ]]; then
	eslint_bin="$repo_root/node_modules/.bin/eslint"
fi

tsc_bin="tsc"
if [[ -x "$repo_root/node_modules/.bin/tsc" ]]; then
	tsc_bin="$repo_root/node_modules/.bin/tsc"
fi

required_files=(.env-template .env.schema docker-compose.yml entrypoint.sh)
work_root=$(mktemp -d "${TMPDIR:-/tmp}/pre-push-work.XXXXXX")
trap 'rm -rf "$work_root"' EXIT

for sha in "${pushed_shas[@]}"; do
	tree_dir="$work_root/$sha"
	mkdir -p "$tree_dir"
	if ! git archive --format=tar "$sha" </dev/null | tar -x -C "$tree_dir"; then
		echo "pre-push: failed to read commit tree for '$sha'." >&2
		exit 1
	fi

	if [[ -e "$repo_root/node_modules" && ! -e "$tree_dir/node_modules" ]]; then
		ln -s "$repo_root/node_modules" "$tree_dir/node_modules"
	fi

	for file in "${required_files[@]}"; do
		if [[ ! -f "$tree_dir/$file" ]]; then
			echo "pre-push: required file missing: $file" >&2
			exit 1
		fi
	done

	(
		cd "$tree_dir"
		"$eslint_bin" "{src,apps,libs,test}/**/*.ts" </dev/null || exit 1
		"$tsc_bin" --noEmit </dev/null || exit 1
		npm test -- --maxWorkers=2 </dev/null || exit 1
	) || exit 1
done
