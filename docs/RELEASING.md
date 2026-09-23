# Releasing

How a jep release is cut. Most of it is CI; the one-time part is the signing
key. See [CONTRIBUTING](../CONTRIBUTING.md) for the contribution flow and
[PROCESSES](PROCESSES.md) for the daemon's deploy ritual.

## What actually ships

- **The daemon / CLI** has no build artifact. It runs from source
  (`npx --yes github:tinybig-ai/jep`, or a checkout), so "shipping" it means
  merging to `main`. Its version is `package.json`.
- **The Android client** ships as a **signed APK** attached to a GitHub Release.
  Its `versionName`/`versionCode` are stamped from the tag at build time.

## One-time: the signing key

The release APK must be signed with a key that lives nowhere in the repo. Set it
up once:

1. Generate a release key and keep it out of the tree. **Back it up somewhere
   safe** — losing it means you can never update the app again:
   ```sh
   keytool -genkeypair -v -keystore jep-release.jks -alias jep \
     -keyalg RSA -keysize 4096 -validity 10000
   ```
2. Add these under **Settings → Secrets and variables → Actions**:
   - `ANDROID_KEYSTORE_BASE64` — the output of `base64 -i jep-release.jks`
   - `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`
3. Nothing else. The workflow decodes the key to a temp file at build time; the
   keystore and `android/keystore.properties` are gitignored.

Debug builds and PRs need none of this.

## Cutting a release

1. Make sure `main` is green — the `check` and `android` workflows pass.
2. Pick the version (semver; the project is pre-`1.0`, so a minor bump may carry
   a breaking change — say so in the notes).
3. Bump the daemon version in `package.json` and commit it to `main`.
4. Tag and push:
   ```sh
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```
5. The `release` workflow builds the signed APK, stamps it with the tag's
   version (`versionName=0.2.0`, `versionCode` from the run number), and attaches
   it to the GitHub Release for that tag. Watch the run.
6. Verify: the Release has `jep-0.2.0.apk`. Optionally install it —
   `adb install jep-0.2.0.apk`.

## When it goes wrong

- Tags are cheap. Delete and re-tag:
  ```sh
  git push --delete origin v0.2.0
  git tag -d v0.2.0
  ```
  Re-running the workflow for an existing tag just re-uploads the asset
  (`--clobber`).
- Without the secrets, the release job **fails loudly** rather than shipping an
  unsigned APK. That is intentional.
- A bad Release can be deleted in the GitHub UI; the APK is not otherwise
  published anywhere.

## Testing a release build locally

With a keystore and `android/keystore.properties` in place:

```sh
cd android
JAVA_HOME=/path/to/jdk17 ./gradlew :app:assembleRelease
```

`gradlew` needs `JAVA_HOME` (unlike a Homebrew `gradle`). Verify the result is
signed: `apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk`.

## Trust

Anyone who can push a `v*` tag, or edit repository secrets, can produce a signed
release. If that ever stops being just you, protect tags and the secrets
environment before adding collaborators.
