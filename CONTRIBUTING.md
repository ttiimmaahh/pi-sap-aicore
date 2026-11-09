# Contributing

Thanks for helping improve `pi-sap-aicore`. It runs inside people's Pi sessions with
their SAP credentials, so changes get careful review. These rules apply whether you
write the change yourself or with an AI agent.

To report a security problem, follow [`SECURITY.md`](SECURITY.md) and keep it out of
public issues and PRs.

## Before you start

- Open an issue to agree the approach before changing behavior. Typos and small
  documentation fixes can go straight to a PR.
- Keep each PR to one concern, so it can be reviewed and reverted on its own.

## Files maintainers change

Leave these out of your PR, and open an issue if one needs changing:

- `package-lock.json`, `.npmrc`, and dependency versions in `package.json`
- anything under `.github/`
- `scripts/build.mjs` and `scripts/bundle-banner.js`

Locked dependencies end up inside the published bundle, and these files control what
gets built and released. Fork PRs that touch them fail the `Fork policy` check.

## Changing the code

- Treat existing workarounds as evidence. Many exist because of a specific SAP error,
  so read the comment and the commit that added one (`git log -S`). If you remove one,
  show that the error no longer happens on the models it protected.
- Keep restricted licenses out of the bundle. `@sap/xssec` and `@sap/xsenv` stay
  external because SAP's Developer License doesn't allow making them available to third
  parties.
- Test what ships. Users load `dist/index.js`, which can behave differently from
  `index.ts`.

## Before you open a PR

Run these and include the result in your PR:

```bash
npm ci
npx tsc --noEmit
npm test
npm run test:bundle
```

`test:bundle` covers Node, and also Bun if it finds Pi's standalone binary (set
`PI_STANDALONE_BIN`). CI on a fork PR runs after a maintainer approves it.

## Back up your claims

If you say something was validated against SAP, list the models, SAP AI SDK version,
Pi version, and exactly what you ran. Behavior differs by model and by what a tenant
offers, so say which models you could not test.

## Keep secrets out

Keep service keys, tokens, tenant URLs, and resource group names out of issues, PRs,
and logs. Files from `PI_SAP_AICORE_DEBUG_PAYLOAD` contain full prompts, so summarize
or redact them instead of attaching them.

## AI-assisted contributions

AI-assisted work is welcome, on these terms:

- Say that you used AI, and which tool, in the PR description.
- A person reads the whole change, runs the checks above, and answers review comments.
- Agents open a PR only after that person has approved it.

## What happens next

A maintainer may reapply a small change by hand with a co-author credit to you, rather
than merging your branch. It's the normal route for changes that touch dependencies or
need adjusting, and your credit stays on the commit.
