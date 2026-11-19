# Changesets

Every pull request into `develop` that changes what users get needs a changeset. It is the
sentence (or two) that ends up in `CHANGELOG.md` and in the GitHub Release notes.

```bash
npx changeset
```

Pick the bump:

| Bump | Use it for | Example |
| --- | --- | --- |
| `patch` | Bug fix, docs, internal cleanup with no user-visible behaviour change | `fix: keep `get` from overwriting existing files` |
| `minor` | New flag, command, event or behaviour | `feat: add --json to peardrop get` |
| `major` | Only after 1.0. A breaking change while on 0.x is a **minor** bump, because `0.x` minors are the breaking ones | `feat!: rename --out to --output` |

Write for someone using the CLI, not for someone reading the diff: say what changed and what they
have to do about it. Commit the generated `.changeset/*.md` file with your change.

Repo-only work (CI, workflows, release scripts, labels) does not need a changeset. Add the
`no-changeset` label to the PR instead.

At release time `npm run release:prepare` consumes these files: it bumps `package.json`, writes
`CHANGELOG.md` and deletes the consumed entries. See [../docs/releasing.md](../docs/releasing.md).
