# standdown.js policy packs

All bundled policies were last verified on `2026-07-10`. Each policy carries
`metadata.sourceUrl`, `metadata.lastVerified`, and optional `metadata.notes`.

## Defaults

`cocDefaults` implements the Affiliate Software Code of Conduct duration model
used when a network-specific duration is not available: advertiser scope,
60-minute inactivity window, 90-minute fallback minimum, and complete
suppression behaviors (`suppress-prompts`, `no-cookie-write`, `no-redirect`,
`no-background-tracking`).

## Pack sources

| Policy | Signals | Stand-down | Activation | Primary citation |
| --- | --- | --- | --- | --- |
| `cj` | `cjevent`, `cjdata`, `utm_source=cj`, `sf_cs=cj`, `afsrc=1`, CJ rotating domains, `cje` / `cjevent_dc` cookie names | Session-or-minimum 30m | User click | https://www.cj.com/legal/software-policy and https://github.com/piedotorg/standdown-domains |
| `impact` | `afsrc=1`, `irclickid`, `irgwc`, `im_ref` cookie names | Session-or-minimum 30m | User click | https://impact.com/stand-down-policy.ihtml |
| `rakuten` | `ranMID` + `ranEAID` + `ranSiteID`, `ranEAID` + `ranSiteID`, `ranSiteID`, `siteID`, LinkSynergy/JRS redirect domains, LinkShare cookie names | Session-or-minimum with CoC fallback minimum | User click | https://github.com/rakutenrewards/PublisherStandown-SDK |
| `awin` | `awc`, `utm_source=aw`, `source=aw`, `awin1.com` | CoC defaults | User click | https://success.awin.com/s/article/Downloadable-Software-Guidelines, https://success.awin.com/s/article/Soft-Click-Cookie-Status, and https://github.com/piedotorg/standdown-domains |
| `shareasale` | `sscid`, `shareasale.com`, `shrsl.com`, `sscid` cookie names | CoC defaults | User click | https://success.awin.com/s/article/Downloadable-Software-Guidelines and https://github.com/piedotorg/standdown-domains |
| `ebay-epn` | `campid`, `pubid`, `mkevt`, `mkcid`, `mkrid`, `[campid + _trkparms]`, `[mktype + gclid]`, `rover.ebay.com`, non-approved referrer class scoped to `ebay.<tld>` | CoC defaults | User click, max 2 prompts, own-site/organic/direct only | https://partnernetwork.ebay.com/browser-extension-policy and https://github.com/piedotorg/standdown-domains |
| `amazon` | `tag` | CoC fallback minimum for detected attribution visibility | Never | https://affiliate-program.amazon.com/help/operating/policies |
| `sovrn-skimlinks` | `go.skimresources.com`, `go.redirectingat.com` | CoC defaults | User click | https://www.sovrn.com/sovrn-commerce-publisher-code-of-conduct/ |
| `partnerize` | `clickref`, `prf.hn` | CoC defaults | User click | https://partnerize.com/legal/terms-and-conditions/ |
| `universal` | Full piedotorg/standdown-domains regex rule list, plus `afsrc=1` final-URL detection | CoC defaults | User click | https://github.com/piedotorg/standdown-domains and https://raw.githubusercontent.com/piedotorg/standdown-domains/main/standdown-domains.json |

Low-confidence entries remain bundled but are explicitly marked in
`metadata.notes`: `sovrn-skimlinks` redirect domains and `partnerize` `prf.hn`
were taken from research/domain knowledge rather than verified network policy
docs.

## Third-party data attribution

The `universal` policy imports the full
`piedotorg/standdown-domains` rule set from
https://raw.githubusercontent.com/piedotorg/standdown-domains/main/standdown-domains.json.
That repository is licensed MIT:

> Copyright (c) 2025 The People's Internet Experiment Inc.

The bundled rules preserve the upstream comments as `DomainRule.comment`
values, with wording adjusted only to make the attribution explicit.
