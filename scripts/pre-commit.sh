#!/usr/bin/env bash
# Validates staged files in backend-payments: gitleaks (staged mode),
# eslint (without --fix), and prettier --check on staged index blobs.
set -euo pipefail

if [[ ! -f /.dockerenv && -z ${PRE_COMMIT_IN_CONTAINER:-} && -f scripts/in-container.sh ]]; then
	PRE_COMMIT_IN_CONTAINER=1 exec bash scripts/in-container.sh bash scripts/pre-commit.sh "$@"
fi

GITLEAKS_VERSION="8.24.3"
GITLEAKS_SHA256="9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c"

ensure_gitleaks() {
	if command -v gitleaks >/dev/null 2>&1; then
		local current_ver
		current_ver=$(gitleaks version 2>/dev/null | head -n1 | tr -d 'v\r ' || true)
		if [[ $current_ver == "$GITLEAKS_VERSION" ]]; then
			command -v gitleaks
			return 0
		fi
	fi

	local cache_dir="node_modules/.cache/gitleaks/v${GITLEAKS_VERSION}"
	local cached_bin="${cache_dir}/gitleaks"
	if [[ -x $cached_bin ]]; then
		if [[ -w /usr/local/bin && ! -x /usr/local/bin/gitleaks ]]; then
			cp "$cached_bin" /usr/local/bin/gitleaks 2>/dev/null || true
		fi
		printf '%s\n' "$cached_bin"
		return 0
	fi

	local tmp_dir
	tmp_dir=$(mktemp -d /tmp/gitleaks-install.XXXXXX)
	local tarball="${tmp_dir}/gitleaks.tar.gz"
	local base_url="https://github.com/gitleaks/gitleaks/releases/download"
	local url="${base_url}/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"

	if ! wget -qO "$tarball" "$url"; then
		rm -rf "$tmp_dir"
		echo "pre-commit: failed to download gitleaks v${GITLEAKS_VERSION}" >&2
		return 1
	fi

	if ! printf '%s  %s\n' "$GITLEAKS_SHA256" "$tarball" | sha256sum -c - >/dev/null 2>&1; then
		rm -rf "$tmp_dir"
		echo "pre-commit: gitleaks v${GITLEAKS_VERSION} sha256 checksum mismatch" >&2
		return 1
	fi

	tar -xzf "$tarball" -C "$tmp_dir" gitleaks
	chmod 0755 "${tmp_dir}/gitleaks"

	if [[ -d node_modules && -w node_modules ]]; then
		mkdir -p "$cache_dir"
		cp "${tmp_dir}/gitleaks" "$cached_bin"
		chmod 0755 "$cached_bin"
		rm -rf "$tmp_dir"
		if [[ -w /usr/local/bin ]]; then
			cp "$cached_bin" /usr/local/bin/gitleaks 2>/dev/null || true
		fi
		printf '%s\n' "$cached_bin"
		return 0
	fi

	if [[ -w /usr/local/bin ]]; then
		mv "${tmp_dir}/gitleaks" /usr/local/bin/gitleaks
		rm -rf "$tmp_dir"
		printf '%s\n' "/usr/local/bin/gitleaks"
		return 0
	fi

	local fallback_bin="/tmp/gitleaks-v${GITLEAKS_VERSION}"
	mv "${tmp_dir}/gitleaks" "$fallback_bin"
	rm -rf "$tmp_dir"
	printf '%s\n' "$fallback_bin"
}

staged_names_out=$(git diff --cached --name-only --diff-filter=ACMR)
if [[ -z $staged_names_out ]]; then
	exit 0
fi
mapfile -t staged_files <<<"$staged_names_out"

gitleaks_bin=$(ensure_gitleaks)
status=0

if ! "$gitleaks_bin" protect --staged --redact -v; then
	status=1
fi

ts_files=()
for file in "${staged_files[@]}"; do
	if [[ $file == *.ts ]]; then
		ts_files+=("$file")
	fi
done

if ((${#ts_files[@]} > 0)); then
	stage_dir=$(mktemp -d "${TMPDIR:-/tmp}/pre-commit-stage.XXXXXX")
	trap 'rm -rf "$stage_dir"' EXIT

	if [[ -e node_modules ]]; then
		ln -s "$PWD/node_modules" "$stage_dir/node_modules"
	fi
	for cfg in eslint.config.js tsconfig.json .prettierrc package.json; do
		if [[ -f $cfg ]]; then
			cp "$cfg" "$stage_dir/$cfg"
		fi
	done

	staged_ts_files=()
	for file in "${ts_files[@]}"; do
		mkdir -p "$stage_dir/$(dirname "$file")"
		if git show ":$file" >"$stage_dir/$file" 2>/dev/null; then
			staged_ts_files+=("$file")
		fi
	done

	if ((${#staged_ts_files[@]} > 0)); then
		eslint_bin="eslint"
		if [[ -x ./node_modules/.bin/eslint ]]; then
			eslint_bin="$PWD/node_modules/.bin/eslint"
		fi
		if ! (cd "$stage_dir" && "$eslint_bin" -- "${staged_ts_files[@]}"); then
			status=1
		fi

		prettier_bin="prettier"
		if [[ -x ./node_modules/.bin/prettier ]]; then
			prettier_bin="$PWD/node_modules/.bin/prettier"
		fi
		if ! (cd "$stage_dir" && "$prettier_bin" --check -- "${staged_ts_files[@]}"); then
			status=1
		fi
	fi
fi

exit "$status"
