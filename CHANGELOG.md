# [1.1.0](https://github.com/christancho/simplefin-wealthfolio-addon/compare/v1.0.0...v1.1.0) (2026-08-28)


### Features

* add a stable download link to the README ([1ab1e86](https://github.com/christancho/simplefin-wealthfolio-addon/commit/1ab1e865fa852ce9ba34a9a75ab32ec9f1f7d207))

# 1.0.0 (2026-08-28)


### Bug Fixes

* address final review findings (failure visibility, field fidelity, retry loop, test coverage) ([c18df79](https://github.com/christancho/simplefin-wealthfolio-addon/commit/c18df7959ac1efa29027b00f192088e6049cdd70))
* address final review findings (field fidelity, test strength, doc accuracy) ([a6a9e8f](https://github.com/christancho/simplefin-wealthfolio-addon/commit/a6a9e8f2c83242a8a33b11cfefc67604028be51e))
* close final-review gaps in credit-card reclassification (issue [#50](https://github.com/christancho/simplefin-wealthfolio-addon/issues/50)) ([e47af32](https://github.com/christancho/simplefin-wealthfolio-addon/commit/e47af32966cfdc8737effb85b2e4d9b48203e740))
* declare secrets.use permission in manifest ([f2fe33c](https://github.com/christancho/simplefin-wealthfolio-addon/commit/f2fe33cc2c6130d1b1e5e057b3cdc43c2522cff5))
* emit CREDIT instead of DEPOSIT for money landing on a credit-card account ([a51479a](https://github.com/christancho/simplefin-wealthfolio-addon/commit/a51479af9c2df31dfc6d8b7450a9daee91d92c0f))
* expire legacy staging records missing inflowActivityType; add DEPOSIT-flow ambiguous/resolveAmbiguous test coverage ([3e2ded3](https://github.com/christancho/simplefin-wealthfolio-addon/commit/3e2ded314fa515daad18fdc28067aeba814f2252))
* format staged amounts as currency and show a table in the withdrawal picker ([278609c](https://github.com/christancho/simplefin-wealthfolio-addon/commit/278609cfc35f80c6bb852528f8c53dc6f563f878))
* import opening-balance plug as DEPOSIT/WITHDRAWAL, not TRANSFER_IN/OUT ([a097eea](https://github.com/christancho/simplefin-wealthfolio-addon/commit/a097eeaa0af0e3252dd1fe674bf789db9cf04da2))
* link reclassified transfer legs via sourceGroupId instead of update() ([28a58c5](https://github.com/christancho/simplefin-wealthfolio-addon/commit/28a58c5e7e5fc28f2a7c519819a998e6522c6ec8))
* populate project-config.json on dev lineage ([f983af3](https://github.com/christancho/simplefin-wealthfolio-addon/commit/f983af33161d951baff74c1564316f569201e595))
* prevent double-claimed withdrawals and restore empty-cashAccountIds guard ([d866a3c](https://github.com/christancho/simplefin-wealthfolio-addon/commit/d866a3cea6bf4cdf2de8a7bb7793e6ac49d7c26f))
* reclassify both legs via a single saveMany call ([3978986](https://github.com/christancho/simplefin-wealthfolio-addon/commit/397898614170212c36194fb099c4751f18c1c572))
* rename Scan button to reflect it now also finds old transfers ([f66643c](https://github.com/christancho/simplefin-wealthfolio-addon/commit/f66643cccb3ba861681db696b1b395acb432cd0b))
* rename Scan button to spell out payments, transfers, and unlinked pairs ([6236492](https://github.com/christancho/simplefin-wealthfolio-addon/commit/62364926584884367f01c309d7862842735d5a89))
* reorder Staged tab columns to date, comment, status, amount, action ([420b9d0](https://github.com/christancho/simplefin-wealthfolio-addon/commit/420b9d0a41912d059ac532200056c2281dc725ac))
* repair opening-balance backfill (permissions, watermark key, date range, balance source) ([85286ff](https://github.com/christancho/simplefin-wealthfolio-addon/commit/85286ff9946ef9a460a3a33de3f919745ff4e026)), closes [#61](https://github.com/christancho/simplefin-wealthfolio-addon/issues/61)
* send isDefault/isActive on account creation ([46a491d](https://github.com/christancho/simplefin-wealthfolio-addon/commit/46a491de53979927347b001e59cb00f4aa7ff517))
* send required symbol field on cash activity imports ([71fde26](https://github.com/christancho/simplefin-wealthfolio-addon/commit/71fde26cf5ce96e9db6f929422a9aae2c56bda76))
* show a loading spinner for accounts and hide already-mapped Wealthfolio accounts ([2e8a636](https://github.com/christancho/simplefin-wealthfolio-addon/commit/2e8a63669cf83c9735c17c985c3fdb2583712f80))
* stop bundle hang and declare secrets.use permission ([cf158f7](https://github.com/christancho/simplefin-wealthfolio-addon/commit/cf158f780e4979dcf0383896af7bd519fd5b1a44)), closes [#45](https://github.com/christancho/simplefin-wealthfolio-addon/issues/45)
* stop Scan button from stretching full-width with an invisible border ([2bf5939](https://github.com/christancho/simplefin-wealthfolio-addon/commit/2bf5939d6bce61e77d5af168923f1ab726e98631))
* surface errors from load/dismiss/openResolve in StagedTransactionsList ([1cb476e](https://github.com/christancho/simplefin-wealthfolio-addon/commit/1cb476ee00b4250bd16cc83e6c9249bb7251ab29))
* use filled Button variant on Scan button to match Sync now ([22ac8cb](https://github.com/christancho/simplefin-wealthfolio-addon/commit/22ac8cb64433f3bfd8c38fb4a2e0b88280d3b1c8))


### Features

* add a Date column to the Staged tab ([d9eb1ea](https://github.com/christancho/simplefin-wealthfolio-addon/commit/d9eb1ea8bb75c430ced6aac2e8d886a4e28bdb59))
* add a Transfer detection keyword editor to Settings ([ebfcf57](https://github.com/christancho/simplefin-wealthfolio-addon/commit/ebfcf57dcdbd1feb0fe61ad48f5eba08e584a093))
* add brokered SimpleFIN client and setup-token claim ([79156b3](https://github.com/christancho/simplefin-wealthfolio-addon/commit/79156b33f7a1ec7e325cb8e5e630bc97f7dd054d))
* add configurable payment keywords to SyncConfig ([852a80d](https://github.com/christancho/simplefin-wealthfolio-addon/commit/852a80d008e5f2b95b1a81751fbd7e163618974d))
* add configurable transfer keywords to SyncConfig ([ef93342](https://github.com/christancho/simplefin-wealthfolio-addon/commit/ef933421c836bd3ad4171b73f4c672653ec2d9c5))
* add reconciliation pass matching staged candidates to withdrawals ([41d16b6](https://github.com/christancho/simplefin-wealthfolio-addon/commit/41d16b671c838d7ea37bbc205c0e98c1a44ee4d7))
* add relinkUnlinkedTransferPairs to backfill sourceGroupId onto pre-existing transfer pairs ([4f80ea0](https://github.com/christancho/simplefin-wealthfolio-addon/commit/4f80ea0a36c7cb72e583004d6b828c6ad7218038))
* add setup and account-mapping UI ([6fa50d8](https://github.com/christancho/simplefin-wealthfolio-addon/commit/6fa50d8ef1eec10d49345537667c434390ed7d79)), closes [#12](https://github.com/christancho/simplefin-wealthfolio-addon/issues/12)
* add Staged tab to the Sync page ([1ccae02](https://github.com/christancho/simplefin-wealthfolio-addon/commit/1ccae022b5f44e7ef243c25e0b2a0749462f68a2))
* add Staged Transactions list with dismiss and ambiguous-resolve UI ([72330dc](https://github.com/christancho/simplefin-wealthfolio-addon/commit/72330dc3b1f4f95387cecfa947c69064d6ec2f0d))
* add staging store for credit-card payment reconciliation candidates ([8b70281](https://github.com/christancho/simplefin-wealthfolio-addon/commit/8b7028142281ab83af33656ff956294d6375d937))
* add storage layer with bounded watermark, config and history ([24a059c](https://github.com/christancho/simplefin-wealthfolio-addon/commit/24a059cbc6cda7c0c4f75dee72bfb1723712237a))
* add sync trigger, results, bridge errors and history UI ([220c19b](https://github.com/christancho/simplefin-wealthfolio-addon/commit/220c19b9a3954f8d7b2815f1e3e8e0ab693a2068))
* automate versioning and GitHub Releases via semantic-release ([4173e61](https://github.com/christancho/simplefin-wealthfolio-addon/commit/4173e619a3f175e28835c3a01242b761d0707a06)), closes [#52](https://github.com/christancho/simplefin-wealthfolio-addon/issues/52)
* backfill opening balance on a CASH mapping's first sync ([7d2967c](https://github.com/christancho/simplefin-wealthfolio-addon/commit/7d2967ce2ef2f44026b79675eccd29fc188ede54))
* backfill-reclassify credit-card payments imported before staging existed ([9351245](https://github.com/christancho/simplefin-wealthfolio-addon/commit/9351245ab43537645f033f544750e8021543ce88))
* detect and reconcile cash-to-cash transfers alongside credit-card payments ([cc36474](https://github.com/christancho/simplefin-wealthfolio-addon/commit/cc3647418fad175f131637fe0af3ea232995b334))
* detect keyword-matched credit-card payments as staging candidates ([2691fa4](https://github.com/christancho/simplefin-wealthfolio-addon/commit/2691fa4f081eddaff159ccf00a94843ce44c7e3d))
* group the Staged tab by credit-card account ([01aa03b](https://github.com/christancho/simplefin-wealthfolio-addon/commit/01aa03b52e1af35b0408cb47ca504b69cc8649c4))
* label staged candidates as Card payment or Cash transfer in the Staged tab ([73cbdc2](https://github.com/christancho/simplefin-wealthfolio-addon/commit/73cbdc24aa8a3702f06b4cd36a8b9d4c5b131da7))
* make payment-detection keywords user-editable in Settings ([7786139](https://github.com/christancho/simplefin-wealthfolio-addon/commit/778613900cd7461da77ea0df45fd2ee731a27f91))
* orchestrate sync with per-account failure isolation ([0bcf592](https://github.com/christancho/simplefin-wealthfolio-addon/commit/0bcf59211c5231cfd250958185c1000042e02df0)), closes [#11](https://github.com/christancho/simplefin-wealthfolio-addon/issues/11)
* parse SimpleFIN accounts response with structured bridge errors ([d1a53fc](https://github.com/christancho/simplefin-wealthfolio-addon/commit/d1a53fc76f972d76712e3ffed4d66361243f3ff2))
* redesign sync UI with tabs and add a Settings panel ([99b2566](https://github.com/christancho/simplefin-wealthfolio-addon/commit/99b2566278576a7f4d4b0e237f075edb5fe79dc8))
* scaffold addon skeleton with vitest harness ([21d3acb](https://github.com/christancho/simplefin-wealthfolio-addon/commit/21d3acb2126bdf597edaf4881343bd903d4a0d20))
* show the transaction date in the withdrawal picker ([3ef2627](https://github.com/christancho/simplefin-wealthfolio-addon/commit/3ef26276bcb49aa35f79ad12369a0de92d9a22e2))
* split SimpleFIN access URL into base URL and basic-auth secret ([036d4d1](https://github.com/christancho/simplefin-wealthfolio-addon/commit/036d4d16a73bc35bce18d2934028cd4dd3fd087b))
* sync SimpleFIN cash transactions with watermark-based idempotency ([5b8043f](https://github.com/christancho/simplefin-wealthfolio-addon/commit/5b8043fcce39f34ddd9fb97c22618911e00bceb7)), closes [#9](https://github.com/christancho/simplefin-wealthfolio-addon/issues/9)
* sync SimpleFIN holdings as Wealthfolio snapshots ([f6c44de](https://github.com/christancho/simplefin-wealthfolio-addon/commit/f6c44de254fa0a23c377953c0ccecacec8c24baa)), closes [#10](https://github.com/christancho/simplefin-wealthfolio-addon/issues/10)
* wire reconciliation pass into runSync ([2c15ffa](https://github.com/christancho/simplefin-wealthfolio-addon/commit/2c15ffab79c67d051aa3a9ba16022587ec3acefe))
* wire relink into the Scan button and surface the result count ([efe38a5](https://github.com/christancho/simplefin-wealthfolio-addon/commit/efe38a59ee1482512ea9db762c5512980b2443ec))

# Changelog

All notable changes to the SimpleFIN Sync addon are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries below this point are generated automatically by
[semantic-release](https://github.com/semantic-release/semantic-release) from
conventional commit messages on every merge to `main`.
