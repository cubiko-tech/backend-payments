#!/usr/bin/env bash
# Cases of pull-env.sh against a fake curl that answers like Infisical with made-up values: nothing reaches a real
# Infisical and no real secret is involved. Needs bash and jq; run it in a container:
#   docker run --rm -v "$PWD:/repo:ro" alpine:3.23.7 sh -c 'apk add -q bash jq && bash /repo/scripts/pull-env.test.sh'
set -u
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pull-env.sh"
fails=0

bench() {
  local dir
  dir=$(mktemp -d)
  mkdir -p "$dir/svc/scripts" "$dir/bin"
  cp "$SRC" "$dir/svc/scripts/pull-env.sh"
  printf 'service: backend-payments\n' > "$dir/svc/.env.schema"
  cat > "$dir/bin/curl" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  *secretPath=/shared*) echo '{"secrets":[{"secretKey":"SHARED_X","secretValue":"s1"},{"secretKey":"POSTGRES_DB","secretValue":"shared"}]}' ;;
  *) echo '{"secrets":[{"secretKey":"CONTAINER_SLUG","secretValue":"roax-payments"},{"secretKey":"POSTGRES_DB","secretValue":"payments"}]}' ;;
esac
FAKE
  chmod +x "$dir/bin/curl"
  echo "$dir"
}

pull() {
  local dir=$1
  PATH="$dir/bin:$PATH" INFISICAL_URL=http://fake INFISICAL_TOKEN=fake INFISICAL_PROJECT_ID=fake \
    bash "$dir/svc/scripts/pull-env.sh" > "$dir/out" 2>&1
}

check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

# CA4 — without .line-vars the .env is what Infisical has, as today.
d=$(bench)
pull "$d"
code=$?
check 'without .line-vars the pull ends well' "[ $code = 0 ]"
check 'without .line-vars the .env is the Infisical one' \
  "grep -qx 'CONTAINER_SLUG=roax-payments' '$d/svc/.env' && grep -qx 'SHARED_X=s1' '$d/svc/.env'"
check 'a key in /shared and in the service is kept once, with the service value' \
  "grep -qx 'POSTGRES_DB=payments' '$d/svc/.env' && [ \$(grep -c '^POSTGRES_DB=' '$d/svc/.env') = 1 ]"
d=$(bench)
printf '# only a comment\n' > "$d/svc/.line-vars"
pull "$d"
code=$?
check 'a .line-vars with only comments ends well' "[ $code = 0 ] && grep -qx 'CONTAINER_SLUG=roax-payments' '$d/svc/.env'"

# CA2 — the line's own values win over Infisical's. RED if .line-vars is not appended last.
d=$(bench)
printf '# payments line\nCONTAINER_SLUG=roax-payments-line\nRUN_FIXTURES=false\n' > "$d/svc/.line-vars"
pull "$d"
check 'a .line-vars value wins over Infisical' \
  "grep -qx 'CONTAINER_SLUG=roax-payments-line' '$d/svc/.env' && [ \$(grep -c '^CONTAINER_SLUG=' '$d/svc/.env') = 1 ]"
check 'a .line-vars key Infisical lacks is added' "grep -qx 'RUN_FIXTURES=false' '$d/svc/.env'"
check 'the rest of the .env is still Infisical' "grep -qx 'POSTGRES_DB=payments' '$d/svc/.env'"

# CA3 — a key outside the allowed list stops the pull. RED if the list is not enforced: a secret gets in.
d=$(bench)
printf 'SUPERADMIN_PASSWORD=made-up\n' > "$d/svc/.line-vars"
pull "$d"
code=$?
check 'a key outside the list stops the pull' "[ $code -ne 0 ] && grep -q 'SUPERADMIN_PASSWORD' '$d/out'"
check 'and writes no .env' "[ ! -e '$d/svc/.env' ]"

[ "$fails" = 0 ] && echo "pull-env: all cases pass" || echo "pull-env: $fails failed"
exit "$fails"
