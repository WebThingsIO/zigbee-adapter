#!/bin/bash

rm -rf node_modules
yarn install --production
rm -f SHA256SUMS
sha256sum package.json *.js LICENSE > SHA256SUMS
find node_modules/ -type f -exec sha256sum {} \; >> SHA256SUMS
TARFILE=$(npm pack)
tar xf ${TARFILE}
cp -r node_modules ./package
tar cf ${TARFILE} package
rm -rf package
echo "Created ${TARFILE}"
