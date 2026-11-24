#!/bin/zsh
set -eu
cd -- "${0:A:h}"
mkdir -p dist
/usr/bin/osacompile -l JavaScript -s -o dist/MoyuReader.app reader.js
/usr/bin/plutil -replace CFBundleIdentifier -string com.moyu.reader dist/MoyuReader.app/Contents/Info.plist
/usr/bin/plutil -replace CFBundleName -string '摸鱼阅读' dist/MoyuReader.app/Contents/Info.plist
/usr/bin/plutil -replace CFBundleDisplayName -string '摸鱼阅读' dist/MoyuReader.app/Contents/Info.plist
/usr/bin/plutil -replace CFBundleShortVersionString -string '1.3.2' dist/MoyuReader.app/Contents/Info.plist
/usr/bin/plutil -replace CFBundleVersion -string '8' dist/MoyuReader.app/Contents/Info.plist
# osacompile adds generic permission descriptions unused by this reader.
for permission in NSAppleEventsUsageDescription NSAppleMusicUsageDescription NSCalendarsUsageDescription NSCameraUsageDescription NSContactsUsageDescription NSHomeKitUsageDescription NSMicrophoneUsageDescription NSPhotoLibraryUsageDescription NSRemindersUsageDescription NSSiriUsageDescription NSSystemAdministrationUsageDescription; do
    if /usr/bin/plutil -extract "$permission" raw dist/MoyuReader.app/Contents/Info.plist >/dev/null 2>&1; then
        /usr/bin/plutil -remove "$permission" dist/MoyuReader.app/Contents/Info.plist
    fi
done
/usr/bin/plutil -replace NSHighResolutionCapable -bool true dist/MoyuReader.app/Contents/Info.plist
/usr/bin/codesign --force --sign - dist/MoyuReader.app
/usr/bin/codesign --verify --strict dist/MoyuReader.app
print '已生成 dist/MoyuReader.app，双击即可打开。'
