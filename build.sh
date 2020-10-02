#!/bin/bash -e

ADDON_ARCH="$1"
LANGUAGE_NAME="$2"
LANGUAGE_VERSION="$3"

function map_posix_tools() {
  tar() {
    gtar "$@"
    return $!
  }
  export -f tar

  readlink() {
    greadlink "$@"
    return $!
  }
  export -f readlink

  find() {
    gfind "$@"
    return $!
  }
  export -f find
}

function install_osx_compiler() {
  brew install \
    boost \
    cmake \
    coreutils \
    eigen \
    findutils \
    gnu-tar \
    pkg-config
  map_posix_tools
}

function install_linux_cross_compiler() {
  sudo apt -qq update
  sudo apt install --no-install-recommends -y \
    binfmt-support \
    qemu \
    qemu-user-static
  docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
}

function build_native() {
  ADDON_ARCH=${ADDON_ARCH} ./package.sh
}

function build_cross_compiled() {
  docker run --rm -t -v $PWD:/build webthingsio/toolchain-${ADDON_ARCH}-${LANGUAGE_NAME}-${LANGUAGE_VERSION} bash -c "cd /build; ADDON_ARCH=${ADDON_ARCH} ./package.sh"
}

case "${ADDON_ARCH}" in
  darwin-x64)
    install_osx_compiler
    build_native
    ;;

  linux-arm)
    install_linux_cross_compiler
    build_cross_compiled
    ;;

  linux-arm64)
    install_linux_cross_compiler
    build_cross_compiled
    ;;

  linux-x64)
    install_linux_cross_compiler
    build_cross_compiled
    ;;

  *)
    echo "Unsupported architecture"
    exit 1
    ;;
esac
