#!/usr/bin/env bash
# Remove reproducible outputs after their readers stop.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1-}" == "--after" ]]; then
  shift
  (( $# > 0 )) || exit 2
  # Wait for the command's readers; preserve its failure if cleanup succeeds.
  trap 'status=$?; bash scripts/clean-generated.sh --build || status=$?; exit "$status"' EXIT
  "$@"
  exit
fi
targets=(dist release-artifacts)
if [[ $# == 0 ]]; then
  targets+=(rust/target rust/bench/target corpus/.reach
    bench/prior-art/.rival-tests bench/prior-art/.native-build
    bench/prior-art/.jsontestsuite bench/prior-art/.jsontestsuite.unversioned
    bench/prior-art/.baseline-candidate.json bench/prior-art/.route-footprint-candidate.json)
elif [[ $# != 1 || "$1" != "--build" ]]; then
  echo "Expected no arguments, --build, or --after <command> [arguments]." >&2
  exit 2
fi
# Discover ownership once, before any deletion: a later tracked target must protect earlier outputs.
tracked=$(git ls-files -- "${targets[@]}")
if [[ -n "$tracked" ]]; then
  printf 'Refusing cleanup of tracked paths:\n%s\n' "$tracked" >&2
  exit 1
fi
for target in "${targets[@]}"; do
  if [[ -e "$target" || -L "$target" ]]; then
    rm -r -- "$target"
  fi
  [[ ! -e "$target" && ! -L "$target" ]]
done
