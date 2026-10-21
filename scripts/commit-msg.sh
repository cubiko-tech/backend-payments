#!/usr/bin/env bash
# Validates commit messages: Conventional Commits, <=72 char subject, Jira Refs, and forbidden AI signatures.
# Usage: commit-msg.sh <msg_file>
set -e

msgfile="${1:?usage: commit-msg.sh <msg_file>}"
if [[ ! -f $msgfile ]]; then
	echo "commit-msg: message file not found: $msgfile"
	exit 1
fi

body=$(sed -E '/^# -+ >8/,$d; /^#/d' "$msgfile")
first_line=$(printf '%s\n' "$body" | head -n1)
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
errors=()

merge_branch_re="Merge (branch|remote-tracking branch|tag) '[^']+'( into .+)?"
merge_branches_re="Merge branches '[^']+'(, '[^']+')* and '[^']+'( into .+)?"
merge_pr_re="Merge pull request #[0-9]+ from .+"
git_generated_re="^($merge_branch_re|$merge_branches_re|$merge_pr_re|Revert \".+\")$"
if [[ ! $first_line =~ $git_generated_re ]]; then
	cnv_re='^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\([a-zA-Z0-9_/.-]+\))?!?:\ .+'
	wip_re='^wip(\([a-zA-Z0-9_/.-]+\))?!?:\ .+'
	if [[ ! $first_line =~ $cnv_re ]] && ! [[ $branch == wip/* && $first_line =~ $wip_re ]]; then
		errors+=("Subject must follow Conventional Commits: type(scope)?: description")
		errors+=("  Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build, revert")
	fi

	if ((${#first_line} > 72)); then
		errors+=("Subject is ${#first_line} chars (max 72). Shorten it or move details to the body.")
	fi

	# A wip/ branch is never published, so it may omit the Jira key; line/payments accepts RXDEV-<n> or PAYL-<n>.
	refs_re='^Refs: RXDEV-[0-9]+$'
	if [[ $branch == "line/payments" ]]; then
		refs_re='^Refs: (RXDEV|PAYL)-[0-9]+$'
	fi
	if [[ $branch != wip/* ]] && ! echo "$body" | grep -qE "$refs_re"; then
		errors+=("Missing 'Refs: <KEY>' line with the Jira key (P4). Only a wip/ branch may omit it.")
	fi
fi

ai_tools='claude|copilot|chatgpt|gpt-?[345]|gemini|cursor|codex|aider|anthropic|openai|bard'
ai_domains='@anthropic\.com|@openai\.com|@cursor\.|@aider\.chat|noreply@anthropic|\+copilot@users\.noreply\.github\.com'
ai_coauthor_re="^[[:space:]]*Co-authored-by:.*(\\b($ai_tools)\\b|$ai_domains)"
ai_generated_re="^[^[:alnum:]]*Generated with (\\[[^]]+\\]|\\b($ai_tools)\\b)"
ai_re="($ai_coauthor_re|$ai_generated_re)"
if echo "$body" | grep -qiE "$ai_re"; then
	errors+=("AI signature or Co-authored-by trailer is forbidden (P1/R8).")
	errors+=("  Remove Co-authored-by or 'Generated with' lines from the commit message.")
fi

if ((${#errors[@]} > 0)); then
	echo "commit-msg: validation failed"
	for e in "${errors[@]}"; do
		echo "  - $e"
	done
	echo ""
	echo "Current subject: $first_line"
	exit 1
fi
