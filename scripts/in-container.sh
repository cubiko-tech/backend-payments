#!/usr/bin/env bash
# Runs a command inside the backend-payments container mounting the caller directory,
# or in an ephemeral container with 4g memory, 4g memory-swap, 4 CPUs, and no fixed IP (R13).
# Usage: bash scripts/in-container.sh <command> [args...]
set -euo pipefail

if (($# == 0)); then
	echo "usage: in-container.sh <command> [args...]" >&2
	exit 2
fi

if ! command -v docker >/dev/null 2>&1 && [[ -f /.dockerenv ]]; then
	export PATH="$PWD/node_modules/.bin:$PATH"
	exec "$@"
fi

caller_dir=$(pwd -P)
script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)

env_args=()
for var_name in NODE_OPTIONS npm_config_verify_deps_before_run CI; do
	if [[ -n ${!var_name:-} ]]; then
		env_args+=(-e "${var_name}=${!var_name}")
	fi
done

ctx_dir=""
cleanup_ctx() {
	if [[ -n $ctx_dir && -d $ctx_dir ]]; then
		rm -rf "$ctx_dir"
	fi
}
trap cleanup_ctx EXIT

if command -v git >/dev/null 2>&1 &&
	git -C "$caller_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	ctx_dir=$(mktemp -d "$caller_dir/.roax-git-ctx.XXXXXX")
	git -C "$caller_dir" rev-parse --abbrev-ref HEAD \
		>"$ctx_dir/branch" 2>/dev/null || true
	git -C "$caller_dir" diff --cached --name-only --diff-filter=ACMR \
		>"$ctx_dir/staged-files.txt" 2>/dev/null || true
	git -C "$caller_dir" diff -U0 --no-ext-diff --staged . \
		>"$ctx_dir/staged-diff.patch" 2>/dev/null || true
	mkdir -p "$ctx_dir/blobs"
	while IFS= read -r rel_file; do
		[[ -n $rel_file ]] || continue
		mkdir -p "$ctx_dir/blobs/$(dirname "$rel_file")"
		git -C "$caller_dir" show ":$rel_file" \
			>"$ctx_dir/blobs/$rel_file" 2>/dev/null || true
	done <"$ctx_dir/staged-files.txt"
	env_args+=(-e "ROAX_GIT_CTX_DIR=$(basename "$ctx_dir")")
fi

if (($# >= 2)) && [[ $1 == "bash" && ! -f "$caller_dir/$2" && -f "$script_root/$2" ]]; then
	if [[ -z $ctx_dir ]]; then
		ctx_dir=$(mktemp -d "$caller_dir/.roax-git-ctx.XXXXXX")
		env_args+=(-e "ROAX_GIT_CTX_DIR=$(basename "$ctx_dir")")
	fi
	cp "$script_root/$2" "$ctx_dir/inline-script.sh"
fi

inner_cmd='
cd "$1" && shift
PATH="$PWD/node_modules/.bin:$PATH"
export PATH
shim_dir=""
if [ -n "${ROAX_GIT_CTX_DIR:-}" ] && [ -d "$PWD/$ROAX_GIT_CTX_DIR" ]; then
  shim_dir=$(mktemp -d /tmp/roax-git-shim.XXXXXX)
  mv "$PWD/$ROAX_GIT_CTX_DIR" "$shim_dir/ctx"
  if [ -f "$shim_dir/ctx/branch" ]; then
    cat << '\''GITSHIM'\'' > "$shim_dir/git"
#!/usr/bin/env bash
ctx_dir="$(cd "$(dirname "$0")/ctx" && pwd -P)"
case "$*" in
  *"rev-parse --abbrev-ref HEAD"*)
    cat "$ctx_dir/branch"
    exit 0
    ;;
  *"diff --cached --name-only"*|*"diff --staged --name-only"*)
    cat "$ctx_dir/staged-files.txt"
    exit 0
    ;;
  *"diff -U0 --no-ext-diff --staged"*)
    cat "$ctx_dir/staged-diff.patch"
    exit 0
    ;;
  show\ :*|*" show :"*)
    for arg in "$@"; do
      case "$arg" in
        :*)
          rel_path="${arg#:}"
          if [ -f "$ctx_dir/blobs/$rel_path" ]; then
            cat "$ctx_dir/blobs/$rel_path"
            exit 0
          fi
          exit 1
          ;;
      esac
    done
    ;;
esac
exit 1
GITSHIM
    chmod +x "$shim_dir/git"
    PATH="$shim_dir:$PATH"
    export PATH
  fi
fi
if [ -n "$shim_dir" ] && [ -f "$shim_dir/ctx/inline-script.sh" ]; then
  shift 2
  bash "$shim_dir/ctx/inline-script.sh" "$@"
  rc=$?
  rm -rf "$shim_dir"
  exit "$rc"
fi
"$@"
rc=$?
[ -n "$shim_dir" ] && rm -rf "$shim_dir"
exit "$rc"
'

mount_fmt="{{range .Mounts}}{{if eq .Source \"$caller_dir\"}}{{.Destination}}{{end}}{{end}}"

# 1. Reuse running container mounting caller_dir
for container in $(docker ps --format '{{.Names}}' 2>/dev/null || true); do
	dest=$(docker inspect "$container" --format "$mount_fmt" 2>/dev/null || true)
	[[ -n $dest ]] || continue
	mem=$(docker inspect "$container" --format '{{.HostConfig.Memory}}' 2>/dev/null || echo 0)
	if [[ $mem == "0" ]]; then
		echo "in-container.sh: container $container has no memory limit (R13)" >&2
		exit 3
	fi
	rc=0
	docker exec -i "${env_args[@]}" "$container" sh -c "$inner_cmd" sh "$dest" "$@" || rc=$?
	exit "$rc"
done

# 2. Ephemeral container with explicit 4g memory, 4g memory-swap, 4 CPUs, and no fixed IP
image="${CONTAINER_NAME:-}"
if [[ -z $image && -f "$caller_dir/.env" ]]; then
	image=$(grep -E '^CONTAINER_NAME=' "$caller_dir/.env" | tail -n1 | cut -d= -f2- | tr -d "'\"\r " || true)
fi
if [[ -z $image && -f "$script_root/.env" ]]; then
	image=$(grep -E '^CONTAINER_NAME=' "$script_root/.env" | tail -n1 | cut -d= -f2- | tr -d "'\"\r " || true)
fi
image="${image:-roax-payments}"

if ! docker image inspect "$image" >/dev/null 2>&1; then
	echo "in-container.sh: image $image is not built" >&2
	exit 4
fi

net_args=()
if docker network inspect cubiko >/dev/null 2>&1; then
	net_args=(--network cubiko)
fi

env_file_args=()
if [[ -f "$caller_dir/.env" ]]; then
	env_file_args=(--env-file "$caller_dir/.env")
fi

rc=0
docker run --rm -i --init --name "roax-efimero-backend-payments-$$" \
	--memory 4g --memory-swap 4g --cpus 4 \
	"${net_args[@]}" "${env_file_args[@]}" "${env_args[@]}" \
	-v "$caller_dir:/code" \
	--entrypoint sh "$image" -c "$inner_cmd" sh /code "$@" || rc=$?
exit "$rc"
