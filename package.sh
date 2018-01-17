#!/bin/bash

rm -f SHA256SUMS
sha256sum *.json *.js LICENSE > SHA256SUMS
npm pack
