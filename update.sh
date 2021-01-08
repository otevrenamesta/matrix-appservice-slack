#!/usr/bin/env nix-shell
#! nix-shell -i bash -p nodePackages.node2nix

node2nix \
  --nodejs-12 \
  --development \
  --lock package-lock.json \
  --input package.json \
  --output node-packages.nix \
  --composition node-composition.nix
