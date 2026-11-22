#!/bin/sh
set -eu

if [ ! -f android/gradlew ]; then
  expo prebuild --platform android --no-install
fi

cd android
exec ./gradlew "$@"
