# npm Publish Guide

## Prerequisites

1. **npm account**: Create one at https://www.npmjs.com/signup
2. **npm login**: Run `npm login` and authenticate
3. **2FA recommended**: Enable on npmjs.com for publish security

## Pre-publish Checklist

```bash
# 1. Verify tests pass
npm run test:run

# 2. Verify build compiles
npm run build

# 3. Check package contents (no test/session leakage)
npm pack --dry-run

# 4. Verify version
node dist/cli.js version

# 5. Verify name availability
npm view ved-ai  # Should return 404 if not yet published
```

## First Publish

```bash
# Login to npm
npm login

# Publish (runs prepublishOnly: clean + build + test automatically)
npm publish --access public

# Verify it's live
npm view ved-ai
```

## Verify Install Works

```bash
# Test in a temp directory
cd /tmp
mkdir ved-test && cd ved-test
npm init -y
npm install ved-ai

# Should show version
npx ved version

# Should run init wizard
npx ved init --yes

# Cleanup
cd .. && rm -rf ved-test
```

## npx Quick Start

After publishing, users can run:
```bash
npx ved-ai init    # Interactive setup
npx ved-ai chat    # Start conversation
npx ved-ai --help  # All commands
```

## Updating

```bash
# Bump version in package.json + src/cli.ts
# Update CHANGELOG.md
# Then:
npm publish
```

## Package Details

- **Name**: `ved-ai`
- **Size**: ~592KB (tarball)
- **Files**: 390 (dist/ + LICENSE + README + CHANGELOG + SECURITY + postinstall)
- **Binaries**: `ved` and `ved-ai`
- **Node**: >=20.0.0
- **Dependencies**: better-sqlite3, ulid, yaml (3 runtime deps)
