#!/bin/sh
# Builds the Linux UID integration image from this checkout's .github directory
# and runs the harness. Needs only a local Docker engine; it makes no network
# call beyond pulling the base image and Debian packages.
set -eu
CONTEXT=$(cd "$(dirname "$0")/.." && pwd)
TAG=${FACTORY_UID_TEST_TAG:-factory-runner-uid-test}
docker build --quiet --file "$CONTEXT/factory-runner-test/Dockerfile" --tag "$TAG" "$CONTEXT" >/dev/null
# --init reaps orphans so a killed agent process is gone, not a zombie.
exec docker run --rm --init --network none "$TAG"
