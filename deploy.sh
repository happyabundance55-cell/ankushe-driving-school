#!/bin/bash
set -e
git add -A
git commit -m "${1:-deploy}" || echo "Nothing to commit"
git push
firebase deploy --only hosting
