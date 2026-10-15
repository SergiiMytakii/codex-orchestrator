# Аудит качества всех тестов — 2026-10-15

## Выполнение исправлений

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Scope: **41 Rewrite + 2 Keep temporarily + 2 мобильных helper = 45/45 исправленных пунктов**. У всех исходных findings ниже указан `Status: rewritten`; исходные классификации и номера строк сохранены как исторический снимок аудита.

**Два transport-отказа исправлены. Окончательный обычный `npm test` завершился полностью зелёным: 655 tests, 655 passed / 0 failed / 0 cancelled / 0 skipped / 0 todo, exit 0, 678.75 s.** Причина воспроизведена до исправления: параллельное обновление Git index в читающих командах конкурировало с `write-tree`. Добавлены три регрессионных случая и точная проверка причины ожидаемого infrastructure failure; проверки, лимиты времени и требуемые результаты не ослаблены.

### Валидация

| Проверка | Команда / среда | Результат |
| --- | --- | --- |
| Предыдущая сборка | `npm run build`, `/tmp/codex-rewriter-verified-validation` | passed, exit 0; clean dist → tsc |
| Typecheck после review | `npm run typecheck`, основная рабочая копия | passed, exit 0 |
| Исторический полный набор до transport repair | `node --test --test-concurrency=1 dist/test/*.test.js`, `/tmp/codex-rewriter-verified-validation` | 650/652, exit 1; 2080.32 s |
| Git snapshot RED → GREEN | `node --test .../test/v2-git-base.test.js` | три новых case падают до fix на реальном `index.lock`; после fix весь файл 5/5 passed |
| Два исходных lifecycle case | `node --test --test-name-pattern='<оба исходных lifecycle case>' dist/test/v2-run-issue.test.js` | 2/2 passed; теперь проверяется точный failure code первой фазы |
| Восстановление каскада второго отказа | один и тот же isolated test с управляемым optional-refresh lock | RED: первый `runner-operation-failed`, второй `direct-review-transport-retryable`; GREEN 1/1 после изменения только Git adapters |
| Callback deadline fixture | `node --test .../test/v2-process-deadline.test.js` | 5/5 passed; timeout 150 ms и exit 124 сохранены |
| Окончательный полный набор | `npm test`, `/tmp/transport-final-validation` | **655/655 passed**, 0 failed/cancelled/skipped, exit 0; 678.75 s; build с очисткой dist включён |
| Упаковка окончательного source | `npm pack --dry-run --json`, `/tmp/transport-package-validation` | passed, exit 0; workflow verified + clean build; `/tmp/transport-final-pack.json` |
| Proof/mobile affected suite | `node --test --test-concurrency=1 /tmp/codex-proof-rewrite-runtime/test/*.test.js` | 84/84 passed |
| Smoke affected suite после repair | `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` | 58/58 passed |
| Целевые review repairs | authoritative scenario + pin/worktree negatives, timeout forwarding, help и cleanup | 7/7 passed |
| Helpers после добавления subprocess bounds | `node --test /tmp/codex-proof-rewrite-runtime/test/v2-mobile-real-gate.test.js` | 2/2 passed |
| Root affected files | восемь test-файлов из per-item Validation ниже | 86/87 в первом запуске; после исправления нерелевантного 5s fixture budget весь check-runtime 11/11 passed; все изменённые проверки прошли |
| Lifecycle findings | пять целевых cases; corrected public-case повторён отдельно | все 5 passed; replay проверяет все три фазы |
| Упаковка до transport repair | `npm pack --dry-run --json` в исходном validation snapshot; prepack включает workflow verification и build | passed, exit 0; transport repair проверяется текущим полным набором |
| Независимый review исходного rewrite | полный Spec + Standards; затем fresh targeted pair на rewrite repair delta | обе проверки APPROVE, blockers 0 |
| Review transport repair | fresh Spec + Standards, затем affected fixture review | **Spec APPROVE + Standards APPROVE**, blockers 0; оба исходных proof/report blockers закрыты |
| Чувствительность новых проверок | три guard mutations; два old-startAt mutations; Android capture до ownership guard | намеренные регрессии обнаружены; после восстановления GREEN |
| Whitespace / syntax | `git diff --check`; `node --check scripts/live-smoke.mjs` | passed |

Изолированная копия содержит точные финальные исходники и tests; проверены SHA-256 всех 123 source/test/script файлов против основной рабочей копии. Посторонние процессы и user-owned runtimes не менялись. Node.js локальной проверки: v24.2.0. Реальные Android/iOS устройства, generated XCUITest, отдельный Flutter widget run и mutating GitHub live smoke не запускались; мобильные helper scripts проверены offline subprocess fixtures. Push, PR и release не выполнялись.

### Два transport-failed — причина и исправление

Status: fixed
Changed files: `src/v2/runtime.ts`, `src/v2/adapters/worktree.ts`, `test/v2-git-base.test.ts`, `test/v2-run-issue.test.ts`

1. **`review blockers form one targeted repair batch bound to fresh affected proof`**. В расширенном повторе исходного compiled case без изменения его assertions получено то же `transport-failed`, cycle 2, attempt `prepared`. Перехват до redaction показал `git failed: fatal: Unable to create .../.git/worktrees/issue-42/index.lock: File exists`. Stack: `getTreeSha` → `snapshotWithIgnoredUntrackedRoot` → fixture implementation baseline, до `onLaunched`. Публичный summary корректно скрывал host path, поэтому предыдущие логи показывали только `Runner operation failed.`.
2. **`settled implementation, proof, and review infrastructure failures resume on the next bounded run`**. Старый первый assertion проверял только произвольный resumable transport failure. Управляемое повторение того же prelaunch index lock воспроизвело точный каскад в варианте `review`: первый вызов не доходил до Review, но assertion его принимал; второй впервые доходил до запланированного `reviewTransportOnce` и снова возвращал `transport-failed`. Одинаковый harness после изменения только Git adapters прошёл 1/1. Исходный исторический лог второго отказа не сохранял evidence code, поэтому его исключение задним числом отдельно не восстанавливается; доказаны воспроизводимый каскад и устранение его причины.

**Runtime fix:** `snapshot` вызывает `diff --binary HEAD` с `git --no-optional-locks`; оба варианта `listChangedFiles` вызывают `status` с тем же флагом. Git не выполняет необязательное обновление index параллельно с `write-tree`. Явные записи и их обязательные locks остаются; любые настоящие Git ошибки по-прежнему дают fail-closed результат. Нет retries, удаления lock чужого процесса или расширения acceptance статусов.

**Регрессионная проверка:** executor контролируемо удерживает реальный `index.lock` в окне optional refresh, пока настоящий `git write-tree` выполняется. Три case охватывают snapshot/diff, snapshot/status и proof snapshot/status с исключением artifact root. До fix все три падают с тем же Git исключением; после fix проверяют точные HEAD/tree, tracked patch hash, untracked content hash, changed files и отсутствие остаточного lock. Lifecycle test дополнительно требует коды `implementation-transport-retryable`, `acceptance-proof-transport-retryable`, `direct-review-transport-retryable` в соответствующих вариантах. Diagnostics обоих исходных assertions теперь включают evidence/events/state.

**Дополнительный отказ полного `npm test`:** callback-deadline case запускал Node VM внутри 150 ms бюджета и под нагрузкой не успевал получить `done`. Для теста завершения output callback достаточно `/bin/sh -c 'printf done'`; fixture заменена, deadline **150 ms**, test timeout **2 s**, ожидаемые exit **124** и stdout **`done`** сохранены. Production deadline policy не менялась.

Логи текущего исправления:

- `/tmp/transport-raw-stress.log` — естественно воспроизведённый исходный отказ, raw stack на строках 416–438; диагностическая серия остановлена после получения доказательства, это не полный контрольный прогон.
- `/tmp/transport-regression-red.log`, `/tmp/transport-regression-green.log` — 3 RED / 5 GREEN.
- `/tmp/transport-second-cascade-red.log`, `/tmp/transport-second-cascade-fixed-green.log` — одинаковый каскадный harness до/после Git fix.
- `/tmp/transport-targets-green.log`, `/tmp/transport-deadline-green.log` — 2/2 lifecycle, 5/5 deadline.
- `/tmp/transport-final-verified-full-test.log` — окончательный обычный `npm test`: **655/655 passed**, 0 failed/cancelled/skipped, exit 0; 678.75 s.
- `/tmp/rewriter-verified-full-test.log` — предыдущий отрицательный полный прогон (650/652), сохранён как история.
- `/tmp/codex-smoke-rewrite-accepted.log`, `/tmp/codex-proof-focused-sequential.log`, `/tmp/rewriter-mobile-timeout-final.log` — предыдущие affected suites.
- `/tmp/rewriter-root-mutation.log`, `/tmp/codex-proof-mobile-mutation.log`, `/tmp/codex-proof-red.log`, `/tmp/codex-proof-green.log` — предыдущие mutation/RED/GREEN evidence.

### Предыдущие полные запуски

- Первый обычный `npm test` после Git fix, до замены Node fixture: **655 tests, 654 passed / 1 failed / 0 cancelled / 0 skipped**, exit 1, 728.44 s (`/tmp/transport-final-full-test.log`). Единственный отказ: callback deadline, stdout пуст вместо `done`; оба исходных lifecycle case и три Git-регрессии прошли.
- Диагностический последовательный прогон до Git fix: 652/652 passed, exit 0, 972.33 s (`/tmp/transport-full-diagnostic.log`). Несмотря на этот green, следующий stress воспроизвёл index lock; одиночный успешный прогон не использован вместо устранения причины.

- Исходный аудит до переписывания: `npm test` — 625 tests, 619 passed, 3 failed, 3 cancelled, 0 skipped; exit 1. Сбои в исходных crash/restart fixtures имели timeout/SIGKILL diagnostics.
- Первый rewritten snapshot с concurrency 2: 649 tests, 642 passed, 7 failed, 0 cancelled/skipped; exit 1. Два неизменённых теста с 5s checkpoint / 150ms deadline затем прошли отдельно 2/2; ещё пять отказов — SIGKILL в crash/restart fixtures. В окончательном последовательном прогоне все эти семь cases прошли. Его три дополнительных smoke cases и subprocess bounds входят в финальную копию.
- Во время проверок наблюдалась системная load average до 286 на машине с 10 CPU. Это контекст, **не доказанная причина** двух оставшихся transport-отказов.

### Что изменено сверх test assertions

- `src/v2/runtime.ts` и `src/v2/adapters/worktree.ts`: отключено только optional обновление index в трёх читающих командах, конкурировавших с snapshot `write-tree`; см. доказательство transport repair выше.

- `scripts/live-smoke.mjs`: import-safe exports существующих helpers и optional explicit `context.commandRunner`; без него сохраняется исходный process boundary. Исходный label-setup block выделен в маленький `prepareLabels`. Это позволяет исполнять настоящие сценарии локально вместо поиска строк в source.
- `src/v2/android-proof-runner.ts`: перед best-effort diagnostic capture в catch проверяется сохранённая emulator identity. До guard два новых adversarial tests фиксировали screencap/uiautomator/logcat чужого emulator; после guard запрещённые действия отсутствуют. Это узкое восстановление уже существующего ownership invariant.
- В изменённом check-runtime fixture npm/Jest selection получил 30s command setup budget; смысл теста — selection policy, а отдельные deadline-тесты по-прежнему защищают ограничения времени.

## Область и метод

Coverage mode: **full audit**. Проверены все **50 `*.test.ts`**, весь **Flutter widget test** и **embedded XCTest** в Ruby-генераторе мобильной фикстуры и вспомогательные файлы `mission-test-temp.ts`, `self-recovery-runner.ts`, `v2-android-real-gate.ts`, `v2-ios-real-gate.ts`. Прочитаны все тестовые файлы целиком, включая fixture/helper код; существенные findings сопоставлены с владельцем в `src/v2/` или `scripts/live-smoke.mjs`. Файлов `not-reviewed` нет. Исходная рабочая копия чистая; HEAD: `4122379b817f6d3900ab7e646f4f621fe5eb3f32`. Тесты и production-код не изменялись.

Единица статической классификации — объявление `test()` / `t.test()` / `testWidgets()` / embedded XCTest method: **577** (575 TypeScript + 1 Dart + 1 embedded XCTest). Цикл с параметрами считается одним объявлением; количество выполненных runtime cases отличается. Один case может содержать хорошие assertions и слабый assertion: тогда всё объявление отмечено `rewrite`. Например, Android runner :23 требует правки только для legacy/verified вариантов, unverified уже содержательно защищён. `Good` означает отсутствие подтверждённой проблемы по этой рубрике, а не доказательство полного покрытия всех возможных ошибок.

**Запуск исходного аудита:** `npm test` завершился после ожидания: 625 runtime tests, 619 passed, 3 failed, 3 cancelled, 0 skipped; exit 1. Сбои/отмены относятся к исходным crash/restart fixtures с короткими timeout под высокой нагрузкой. Лог: `/tmp/codex-test-audit-2026-10-15.log`. Это baseline до исправлений, а не итог текущей ревизии. Классификация аудита основана на полном чтении тестов. Flutter widget test, generated XCTest и real mobile gates тогда отдельно не запускались; после переписывания helpers проверяются offline subprocess-тестами. Mutating `smoke:live` и реальные устройства не запускались. Локальные wrapper self-tests не являются live GitHub smoke.

| Категория | Объявлений |
| --- | ---: |
| Good | 534 |
| Rewrite | 41 |
| Delete | 0 |
| Keep temporarily | 2 |

Ни один существующий тест не рекомендован к удалению целиком. Моки внешних границ, точные argv/DTO, schema/prompt/manifest contracts и порядок durable intent → внешний эффект сами по себе не являются дефектами. Статический аудит подтверждает слабость assertions; отсутствие реального production bug и воспроизводимость flakiness из него не следуют. Отдельный mutation-testing прогон не выполнялся.

## Что исправить в первую очередь

1. **Ложные проверки safety/idempotency:** pending-effect :14/:74, non-visual Android :553, iOS lease :131, duplicate-ID :447. Такие тесты могут пройти при нарушении именно заявленного запрета.
2. **Зависания и таймеры:** bounded handshake/cleanup в check-runtime :103 и run-store :524, затем детерминированные launch/idle gates.
3. **Live-smoke harness:** offline execution вместо source regex для preflight, cleanup, ownership и report normalization; после этого остальные source-shape проверки и lifecycle replay. Все замены выполнять локально с fake GitHub/model boundaries — запрос на аудит не авторизует mutating live smoke.

## Rewrite — полный список

### P1 · [test/v2-acceptance-proof.test.ts:553](../../test/v2-acceptance-proof.test.ts#L553)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-acceptance-proof.test.ts
Validation: `node --test --test-concurrency=1 /tmp/codex-proof-rewrite-runtime/test/*.test.js`
Notes: 84/84 passed; оба stale/fresh helper cases и четыре Android identity-drift границы. Старый fixed-startAt отвергнут mutation probes; catch capture без ownership guard дал RED, с guard GREEN.

**explicit live Android proof rejects non-visual acceptance**

Факт: Тест не достигает non-visual report validation: нет runnerPreparedArtifactPaths, раньше возвращается external-block. status != passed принимает произвольный отказ.

Сохранить: android-live нельзя удовлетворить nonvisual report.

Исправление: Разделить missing preparation (точный external-block, no agent launch) и валидно подготовленный Android input с nonvisual report (точный report-repair/diagnostic, agent launched).

### P1 · [test/v2-check-runtime.test.ts:148](../../test/v2-check-runtime.test.ts#L148)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-check-runtime.test.ts
Validation: `node --test --test-concurrency=2 /tmp/codex-rewriter-root-build/test/v2-{check-runtime,cli,config-contract,gh-pull-request-adapter,pending-effect-settlement,run-store,only-contract,report-contracts}.test.js; затем node --test /tmp/codex-rewriter-root-build/test/v2-check-runtime.test.js`
Notes: 86/87 в первом прогоне; соседний Jest-selection case упёрся в нерелевантный этому контракту 5s launch budget. После увеличения только fixture command budget до 30s весь check-runtime прошёл 11/11. Все изменённые проверки подтверждены. Три изолированные мутации guards (confirmed/diverged effects, duplicate proof IDs) обнаружены.

**check command cannot execute before launched ownership persistence resolves**

Факт: Отсутствие marker проверяется после sleep(100), без подтверждения входа в onLaunched. При задержке планировщика проверка проходит до запуска тестируемого участка, даже если gate сломан.

Сохранить: Команда не выполняется до успешного сохранения launch ownership.

Исправление: Сигнализировать отдельным Promise из onLaunched, дождаться его, проверить marker до release, затем проверить успешный результат и marker после release. Добавить bounded failure cleanup.

### P1 · [test/v2-ios-lease.test.ts:131](../../test/v2-ios-lease.test.ts#L131)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-ios-lease.test.ts
Validation: `node --test --test-concurrency=1 /tmp/codex-proof-rewrite-runtime/test/*.test.js`
Notes: 84/84 passed; оба stale/fresh helper cases и четыре Android identity-drift границы. Старый fixed-startAt отвергнут mutation probes; catch capture без ownership guard дал RED, с guard GREEN.

**runner iOS verifier rejects target identity drift and an expired or unbound lease**

Факт: Expired/unbound мутации меняют только artifact; external остается valid. Ранний identity mismatch маскирует проверку expiry/appPid.

Сохранить: Отказ от identity drift, реально expired и unbound lease.

Исправление: Для expiry/unbound мутировать одинаково external и artifact; проверять not bound and active. Drift оставить отдельными несовпадающими inputs.

### P1 · [test/v2-live-smoke-script.test.ts:76](../../test/v2-live-smoke-script.test.ts#L76)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**authoritative candidate smoke proves mixed-index capture and exact publication cleanup**

Факт: Проверяет наличие сообщений и выражений, не выполнение сравнения tree или cleanup.

Сохранить: Mixed-index candidate публикует точное дерево и удаляет pin/worktree

Исправление: Выполнить scenario с локальными Git fixtures и fake GitHub/model boundary; проверить published tree и отсутствие pin/worktree.

### P1 · [test/v2-live-smoke-script.test.ts:216](../../test/v2-live-smoke-script.test.ts#L216)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**live smoke documents scratch repo and strict cleanup defaults**

Факт: Полезная --help часть смешана с текстовым перечислением cleanup функций.

Сохранить: Scratch repo, cleanup defaults и удаление всех run-owned ресурсов

Исправление: Сохранить help contract; cleanup проверить локальными ресурсами и fake gh с retained baseline и newly-created artifacts.

### P1 · [test/v2-live-smoke-script.test.ts:233](../../test/v2-live-smoke-script.test.ts#L233)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**live smoke preflight is authenticated, scratch-only, and exclusively locked**

Факт: Наличие productionRepo/auth/lock слов не доказывает отказ или порядок до mutation.

Сохранить: Preflight запрещает PROD/неодобренный repo, требует auth, lock и чистый HEAD

Исправление: Таблица preflight отказов на fake command boundary, утверждать отсутствие mutation при каждом отказе.

### P1 · [test/v2-live-smoke-script.test.ts:248](../../test/v2-live-smoke-script.test.ts#L248)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**strict cleanup removes only run-created local resources and requires complete label setup**

Факт: Source regex проверяет имена baseline и наличие SIGTERM/SIGKILL.

Сохранить: Cleanup удаляет только run-owned refs/worktrees/processes; без lock не удаляет ничего

Исправление: Создать baseline+run-owned локальные Git refs/worktrees и isolated child; проверить сохранение baseline и no-lock no-op.

### P1 · [test/v2-live-smoke-script.test.ts:294](../../test/v2-live-smoke-script.test.ts#L294)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**live code review normalization preserves the Runner capsule**

Факт: Regex по generated-wrapper source не выполняет normalizer; wrong target/filter/outcome может сохраниться с теми же токенами.

Сохранить: Review normalization сохраняет target, coverage и finding outcomes

Исправление: В self-test wrapper подать complete/repair capsules и проверить записанный report валидатором.

### P1 · [test/v2-live-smoke-script.test.ts:305](../../test/v2-live-smoke-script.test.ts#L305)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**every live code review is normalized from the runner-owned review capsule**

Факт: Проверяет строки operation/fingerprint/session и writeFileSync.

Сохранить: Каждый review report построен из Runner-owned capsule

Исправление: Подать несовпадающий модельный report и capsule; проверить exact normalized output и binding.

### P1 · [test/v2-live-smoke-script.test.ts:333](../../test/v2-live-smoke-script.test.ts#L333)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**new regression scenarios exercise distinct owner boundaries**

Факт: Один case ищет тексты assertions шести сценариев; сами assertions могут быть unreachable или неверны.

Сохранить: Check/review repair, publication reconciliation, revocation, feedback-negative и issue check contracts

Исправление: Разделить на локальные offline scenarios с fake внешними boundary и проверкой результата/состояния.

### P1 · [test/v2-live-smoke-script.test.ts:380](../../test/v2-live-smoke-script.test.ts#L380)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**proof rework fault discards transient proof evidence before a minimal needs-rework report**

Факт: Regex gitCommonPath/discardProofArtifacts/report fields не проверяет сохранение marker в common-dir.

Сохранить: Proof rework один раз across candidate worktrees, удаляет transient artifacts и возвращает минимальный needs-rework

Исправление: Выполнить wrapper в двух linked worktrees одного repo; проверить one-shot fault и filesystem artifacts.

### P1 · [test/v2-live-smoke-script.test.ts:394](../../test/v2-live-smoke-script.test.ts#L394)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**negative proof fault discards transient evidence before the external blocker report**

Факт: Проверяет только строку вызова.

Сохранить: Negative proof удаляет transient artifacts перед external-block

Исправление: Выполнить fault с созданными proof файлами, проверить report и удаление artifacts; sibling sentinel сохраняется.

### P1 · [test/v2-live-smoke-script.test.ts:401](../../test/v2-live-smoke-script.test.ts#L401)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**review feedback continuation smoke proves same-PR update and effect-free replay**

Факт: Проверяет, что в source присутствуют слова summary marker и rev-list.

Сохранить: Review feedback обновляет тот же PR, связывает свежий proof и replay без effects/model calls

Исправление: Offline сценарий с fake gh/model и локальным Git: exact same PR, changed tree/proof, replay snapshots и нулевые повторные effects.

### P1 · [test/v2-live-smoke-script.test.ts:431](../../test/v2-live-smoke-script.test.ts#L431)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**daemon continuation reads the target issue result from authoritative run state**

Факт: Наличие readRunRecord/terminalOutcome допускает возврат другого outcome.

Сохранить: Daemon continuation берет terminalOutcome нужного issue из authoritative run state

Исправление: Fixture state с несколькими issues и отличающимися stdout; проверить result для запрошенного issue и missing record отказ.

### P1 · [test/v2-live-smoke-script.test.ts:439](../../test/v2-live-smoke-script.test.ts#L439)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**daemon continuation requires exclusive scratch-repository candidate ownership**

Факт: Ищет строки guard и выражений sets; перестановка/пропуск вызова guard может пройти.

Сохранить: Daemon запускается только при exclusive scratch ownership до и после run

Исправление: Fake gh возвращает foreign candidate/missing requested issue; проверить no-launch либо post-run rejection.

### P1 · [test/v2-pending-effect-settlement.test.ts:14](../../test/v2-pending-effect-settlement.test.ts#L14)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-pending-effect-settlement.test.ts
Validation: `node --test --test-concurrency=2 /tmp/codex-rewriter-root-build/test/v2-{check-runtime,cli,config-contract,gh-pull-request-adapter,pending-effect-settlement,run-store,only-contract,report-contracts}.test.js; затем node --test /tmp/codex-rewriter-root-build/test/v2-check-runtime.test.js`
Notes: 86/87 в первом прогоне; соседний Jest-selection case упёрся в нерелевантный этому контракту 5s launch budget. После увеличения только fixture command budget до 30s весь check-runtime прошёл 11/11. Все изменённые проверки подтверждены. Три изолированные мутации guards (confirmed/diverged effects, duplicate proof IDs) обнаружены.

**every finite handler observes a confirmed postcondition without repeating the effect**

Факт: Проверяется только status=confirmed. adapter считает invokes через getter, но результат счётчика никогда не читается. Повторный invoke уже подтверждённого commit/push/comment/PR может остаться незамеченным.

Сохранить: Confirmed postcondition запрещает повтор эффекта во всех шести обработчиках.

Исправление: Хранить каждый adapter с handler и проверять invokes===0 либо делать invoke fail-on-call. Возвращаемый status оставить.

### P1 · [test/v2-pending-effect-settlement.test.ts:74](../../test/v2-pending-effect-settlement.test.ts#L74)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-pending-effect-settlement.test.ts
Validation: `node --test --test-concurrency=2 /tmp/codex-rewriter-root-build/test/v2-{check-runtime,cli,config-contract,gh-pull-request-adapter,pending-effect-settlement,run-store,only-contract,report-contracts}.test.js; затем node --test /tmp/codex-rewriter-root-build/test/v2-check-runtime.test.js`
Notes: 86/87 в первом прогоне; соседний Jest-selection case упёрся в нерелевантный этому контракту 5s launch budget. После увеличения только fixture command budget до 30s весь check-runtime прошёл 11/11. Все изменённые проверки подтверждены. Три изолированные мутации guards (confirmed/diverged effects, duplicate proof IDs) обнаружены.

**diverged and unobserved postconditions fail closed with the intent unchanged**

Факт: Один общий invokes=1 проверяется лишь после diverged и absent сценариев вместе. Он не отличает правильное 0+1 от ошибочного 1+0; intent unchanged из названия также не проверяется.

Сохранить: Diverged запрещает invoke; absent допускает одну попытку, а неподтверждённый результат остаётся unobserved; intent сохраняется.

Исправление: Разделить счётчики/кейсы, assert 0 сразу после diverged, assert 1 после absent; сравнить effect со снимком исходного intent.

### P1 · [test/v2-report-contracts.test.ts:447](../../test/v2-report-contracts.test.ts#L447)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-report-contracts.test.ts
Validation: `node --test --test-concurrency=2 /tmp/codex-rewriter-root-build/test/v2-{check-runtime,cli,config-contract,gh-pull-request-adapter,pending-effect-settlement,run-store,only-contract,report-contracts}.test.js` — оба файла passed в общем root focused-прогоне; изолированная duplicate-ID mutation обнаружена.
Notes: Оба feedback-only статуса проверены с true/false/omitted context; duplicate IDs используют валидный control и reason-specific artifact/criteria mutations.

**proof runtime validation rejects dangling evidence, duplicate IDs, and non-canonical artifact paths**

Факт: passedProof.checks=[]; два checks[0] дают [undefined, undefined].

Сохранить: Dangling refs, duplicate IDs и unsafe artifact paths должны отвергаться по соответствующей причине

Исправление: Валидатор src/v2/proof-report.ts:118 отвергает любой nonempty checks до проверки artifacts, поэтому duplicate-ID контракт не доказан. Использовать два валидных artifacts или criteria с одинаковым ID, убедиться что контрольный distinct-ID report проходит, а duplicate report падает по ID diagnostic. Сохранить остальные два негативных assertions с reason-specific проверками.

### P2 · [test/v2-android-proof-runner.test.ts:23](../../test/v2-android-proof-runner.test.ts#L23)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-android-proof-runner.test.ts
Validation: `node --test --test-concurrency=1 /tmp/codex-proof-rewrite-runtime/test/*.test.js`
Notes: 84/84 passed; оба stale/fresh helper cases и четыре Android identity-drift границы. Старый fixed-startAt отвергнут mutation probes; catch capture без ownership guard дал RED, с guard GREEN.

**runner owns an isolated emulator and enforces ${loginState} proof**

Факт: Legacy/verified варианты требуют emulatorIdentityReads >=5: связано с числом внутренних чтений и не доказывает ownership прямо перед unsafe effects. Unverified вариант содержательно good.

Сохранить: Повторная проверка emulator ownership перед install/navigation/capture, существующие receipt/tamper assertions.

Исправление: Заменить счетчик adversarial сценариями identity drift после boot, перед install и navigation/capture; blocked и отсутствие unsafe effects/foreign kill.

### P2 · [test/v2-cli.test.ts:318](../../test/v2-cli.test.ts#L318)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-cli.test.ts
Validation: `node --test --test-concurrency=2 /tmp/codex-rewriter-root-build/test/v2-{check-runtime,cli,config-contract,gh-pull-request-adapter,pending-effect-settlement,run-store,only-contract,report-contracts}.test.js; затем node --test /tmp/codex-rewriter-root-build/test/v2-check-runtime.test.js`
Notes: 86/87 в первом прогоне; соседний Jest-selection case упёрся в нерелевантный этому контракту 5s launch budget. После увеличения только fixture command budget до 30s весь check-runtime прошёл 11/11. Все изменённые проверки подтверждены. Три изолированные мутации guards (confirmed/diverged effects, duplicate proof IDs) обнаружены.

**CLI help and version are side-effect free**

Факт: Название обещает side-effect free, но проверяются только help/version и exit code. Вызов executeRun/executeDaemon/executeSetup мог бы произойти, и эти assertions не обнаружат его.

Сохранить: Help/version печатают ожидаемый вывод без запуска lifecycle или Setup.

Исправление: Передать fail-on-call зависимости для всех трёх execution границ; сохранить проверки вывода и exit.

### P2 · [test/v2-codex-process.test.ts:323](../../test/v2-codex-process.test.ts#L323)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-codex-process.test.ts
Validation: `node --test --test-concurrency=1 /tmp/codex-proof-rewrite-runtime/test/*.test.js`
Notes: 84/84 passed; оба stale/fresh helper cases и четыре Android identity-drift границы. Старый fixed-startAt отвергнут mutation probes; catch capture без ownership guard дал RED, с guard GREEN.

**idle timeout is reset by stream activity and is distinct from wall timeout**

Факт: Activity обновляется на 15 ms, но elapsed >=35 допускает исходный idle deadline без reset.

Сохранить: Idle timeout отсчитывается после последней активности и отличается от wall deadline.

Исправление: Управляемые часы/таймеры; проверить живой процесс после исходного deadline и timeout после нового.

### P2 · [test/v2-config-contract.test.ts:145](../../test/v2-config-contract.test.ts#L145)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-config-contract.test.ts
Validation: `node --test --test-concurrency=2 /tmp/codex-rewriter-root-build/test/v2-{check-runtime,cli,config-contract,gh-pull-request-adapter,pending-effect-settlement,run-store,only-contract,report-contracts}.test.js; затем node --test /tmp/codex-rewriter-root-build/test/v2-check-runtime.test.js`
Notes: 86/87 в первом прогоне; соседний Jest-selection case упёрся в нерелевантный этому контракту 5s launch budget. После увеличения только fixture command budget до 30s весь check-runtime прошёл 11/11. Все изменённые проверки подтверждены. Три изолированные мутации guards (confirmed/diverged effects, duplicate proof IDs) обнаружены.

**CLI JSON and exit mapping are total over every public runIssue outcome**

Факт: Матрица с названием total over every public outcome пропускает repair-ready и state-schema-unsupported. Отдельные CLI тесты покрывают их сегодня, но эта supposedly-total матрица не гарантирует полноту при новых статусах.

Сохранить: JSON envelope и exit mapping для полного публичного словаря статусов.

Исправление: Добавить пропущенные исходы и assert равенства множества case statuses с RUN_ISSUE_STATUSES; оставить по одному ожидаемому exit и envelope на исход.

### P2 · [test/v2-contained-report-operation.test.ts:144](../../test/v2-contained-report-operation.test.ts#L144)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-contained-report-operation.test.ts
Validation: `node --test --test-concurrency=1 /tmp/codex-proof-rewrite-runtime/test/*.test.js`
Notes: 84/84 passed; оба stale/fresh helper cases и четыре Android identity-drift границы. Старый fixed-startAt отвергнут mutation probes; catch capture без ownership guard дал RED, с guard GREEN.

**quiescence uncertainty returns durable process evidence without an unsafe final snapshot**

Факт: Snapshot stub не наблюдает вызовы; лишний unsafe final snapshot после safe-halt не сломает тест.

Сохранить: Durable baseline и отсутствие final snapshot до доказанного quiescence.

Исправление: Считать snapshot calls и проверить один вызов, а также pid/group/baseline safe-halt evidence.

### P2 · [test/v2-gh-pull-request-adapter.test.ts:154](../../test/v2-gh-pull-request-adapter.test.ts#L154)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-gh-pull-request-adapter.test.ts
Validation: `node --test --test-concurrency=2 /tmp/codex-rewriter-root-build/test/v2-{check-runtime,cli,config-contract,gh-pull-request-adapter,pending-effect-settlement,run-store,only-contract,report-contracts}.test.js; затем node --test /tmp/codex-rewriter-root-build/test/v2-check-runtime.test.js`
Notes: 86/87 в первом прогоне; соседний Jest-selection case упёрся в нерелевантный этому контракту 5s launch budget. После увеличения только fixture command budget до 30s весь check-runtime прошёл 11/11. Все изменённые проверки подтверждены. Три изолированные мутации guards (confirmed/diverged effects, duplicate proof IDs) обнаружены.

**reads paginated submitted reviews and pull request conversation comments with exact identities**

Факт: В тесте paginated submitted reviews and conversation comments обе коллекции помещаются на первой странице; финальный assert даже требует page=1 для всех вызовов. Тест не обнаружит потерю второй страницы conversation comments. Отдельный case :268 защищает только submitted reviews.

Сохранить: Точное преобразование identity и полнота REST conversation comments.

Исправление: Оставить DTO assertions, отдавать 100 comments на первой странице и уникальный comment на второй; проверить возвращённую полную последовательность и прекращение после short page.

### P2 · [test/v2-live-smoke-script.test.ts:50](../../test/v2-live-smoke-script.test.ts#L50)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**V2 regression profile covers each supplemental non-mobile behavior once**

Факт: Парсит литералы source slice между именами Map entries; форматирование или helper ломает тест.

Сохранить: Выбор v2-regression ровно по одному supplemental scenario

Исправление: Проверять результат selectScenarios для --profile v2-regression через безопасный dry-run/plan API.

### P2 · [test/v2-live-smoke-script.test.ts:88](../../test/v2-live-smoke-script.test.ts#L88)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**default core release proves package delivery and post-PR targeted repair**

Факт: Извлекает одинарные строковые литералы из исходника.

Сохранить: Default core-release выбирает package-install и review-feedback-continuation

Исправление: Проверить результирующий scenario plan через CLI dry-run либо чистый selector.

### P2 · [test/v2-live-smoke-script.test.ts:122](../../test/v2-live-smoke-script.test.ts#L122)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**packed smoke resolves the public V2 CLI**

Факт: Regex пути не доказывает, что запускается этот путь.

Сохранить: Smoke использует CLI установленного tarball

Исправление: Через локальный packed fixture перехватить launcher и проверить resolved executable.

### P2 · [test/v2-live-smoke-script.test.ts:272](../../test/v2-live-smoke-script.test.ts#L272)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**every model-backed live smoke invocation pins GPT-5.6 Luna**

Факт: Совпадения константы и строк не доказывают все invocation paths.

Сохранить: Каждый model invocation получает модель и reasoning policy

Исправление: Расширить существующий self-test-live-codex матрицей операций; проверить реальные argv/env и audit receipt.

### P2 · [test/v2-live-smoke-script.test.ts:281](../../test/v2-live-smoke-script.test.ts#L281)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**live smoke starts the packaged runtime without a certification step**

Факт: Совпадение литералов не доказывает runtime launch isolation.

Сохранить: Запускается packaged runtime с отдельным orchestratorHome

Исправление: Проверить вызванный packed CLI и переданный home через stub executable.

### P2 · [test/v2-live-smoke-script.test.ts:288](../../test/v2-live-smoke-script.test.ts#L288)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**real Codex smoke budgets cover the complete multi-operation workflow**

Факт: Проверяет точные присваивания исходника; пропущенная передача timeout пройдет.

Сохранить: Общий и operation timeout достаточны и переданы launcher

Исправление: Проверять effective config/launcher timeout для default run.

### P2 · [test/v2-live-smoke-script.test.ts:323](../../test/v2-live-smoke-script.test.ts#L323)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**diagnostics uses an installed packed CLI and remains model-free**

Факт: Наличие readRemoteSnapshot и отсутствие createIssue не гарантирует отсутствия side effects.

Сохранить: Diagnostics использует installed CLI, без model/GitHub writes

Исправление: Запустить offline diagnostics с packed fixture и fake gh/model; сравнить local/remote snapshot и ноль model launch.

### P2 · [test/v2-live-smoke-script.test.ts:371](../../test/v2-live-smoke-script.test.ts#L371)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**incomplete-progress retry uses a deterministic clean transport failure before the retry**

Факт: Текстовая строка transport fault и отсутствие setInterval не доказывают последовательность.

Сохранить: Incomplete-progress fault детерминирован и retry не зависит от idle-timeout

Исправление: Выполнить generated wrapper дважды, проверить первый failure/второй success и marker.

### P2 · [test/v2-live-smoke-script.test.ts:450](../../test/v2-live-smoke-script.test.ts#L450)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**scenario assertions bind live smoke outcomes to their current owner behavior**

Факт: Наличие диагностических сообщений не доказывает, что нарушение приводит к failure.

Сохранить: Smoke scenario assertions обнаруживают реальные неверные outcomes

Исправление: Подать неправильный CLI path/retry count/publication result в offline assertions и ожидать отказ.

### P2 · [test/v2-live-smoke-script.test.ts:462](../../test/v2-live-smoke-script.test.ts#L462)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-live-smoke-script.test.ts`, `scripts/live-smoke.mjs`
Validation: `node --test --test-reporter=tap /tmp/codex-smoke-rewrite/dist/test/v2-live-smoke-script.test.js` — 58/58 passed; отдельная repair-проверка 7/7 passed.
Notes: исполняются существующие scenario/helpers/generated wrappers с локальным Git и fake external command boundary; текстовые проверки executable logic заменены. После независимого review добавлены вызов authoritative scenario с retained-pin/worktree negatives, timeout forwarding и сохранены три help assertions.

**fixture happy paths normalize proof semantics after real model invocation**

Факт: Regex наличия имен scenarios и helper не проверяет branch execution.

Сохранить: Happy-path proof normalization вызывается после model и только для заданных scenarios

Исправление: Параметризовать generated wrapper self-test по scenarios; проверить порядок model audit, fault и записанный proof.

### P2 · [test/v2-only-contract.test.ts:20](../../test/v2-only-contract.test.ts#L20)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-only-contract.test.ts
Validation: `node --test --test-concurrency=2 /tmp/codex-rewriter-root-build/test/v2-{check-runtime,cli,config-contract,gh-pull-request-adapter,pending-effect-settlement,run-store,only-contract,report-contracts}.test.js` — оба файла passed в общем root focused-прогоне; изолированная duplicate-ID mutation обнаружена.
Notes: Публичный built barrel/CLI исполняется вместо source regex.

**root export barrel and public CLI expose the V2 authority**

Факт: Наличие ./v2/run-issue.js и имени CLI в source проходит даже внутри комментария/неэкспортируемого import.

Сохранить: Публичный barrel экспортирует рабочий V2 runtime, CLI реально доступен

Исправление: Импортировать публичный built barrel и вызвать CLI --help; сверить callable export/observable command contract. Consumer compile test уже дает сильное покрытие части barrel, но не RunIssue.

### P2 · [test/v2-report-contracts.test.ts:243](../../test/v2-report-contracts.test.ts#L243)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-report-contracts.test.ts
Validation: `node --test --test-concurrency=2 /tmp/codex-rewriter-root-build/test/v2-{check-runtime,cli,config-contract,gh-pull-request-adapter,pending-effect-settlement,run-store,only-contract,report-contracts}.test.js` — оба файла passed в общем root focused-прогоне; изолированная duplicate-ID mutation обнаружена.
Notes: Оба feedback-only статуса проверены с true/false/omitted context; duplicate IDs используют валидный control и reason-specific artifact/criteria mutations.

**answer-only and boundary reports require active issue feedback**

Факт: Название обещает оба статуса, fixture и assertions проверяют только answer-only.

Сохранить: answer-only и boundary допускаются только в active issue-feedback контексте

Исправление: Добавить валидный boundary fixture; оба статуса принять при true и отвергнуть при false/omitted.

### P2 · [test/v2-run-issue.test.ts:265](../../test/v2-run-issue.test.ts#L265)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-run-issue.test.ts
Validation: `node --test --test-name-pattern='Run retains proof failure diagnostics|public runIssue reaches review-ready only|missing retained reviewer authority|trusted feedback preserves exact Implement|credential-bearing Review target' /tmp/codex-rewrite-lifecycle-dist/test/v2-run-issue.test.js; затем node --test --test-name-pattern='public runIssue reaches review-ready only' /tmp/codex-rewrite-lifecycle-dist/test/v2-run-issue.test.js`
Notes: Все пять целевых cases passed: 4 в первом прогоне; canonical effectId expectation исправлен и public case повторно passed. Три фазы feedback replay проверены после настоящего сбоя сохранения terminal state.

**Run retains proof failure diagnostics and existing candidate/workflow identity without launching Review or publication**

Факт: Отрицательная проверка на280 ищет event === 'push', traceGit.push на5207 пишет 'git:push'; запрет push фактически не проверяется.

Сохранить: Proof failure diagnostics, candidate/workflow identity, отсутствие Review/publication.

Исправление: Проверять git:push и effect:pr; добавить отсутствие remote branch, сохранив диагностику и state assertions.

### P2 · [test/v2-run-issue.test.ts:701](../../test/v2-run-issue.test.ts#L701)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-run-issue.test.ts
Validation: `node --test --test-name-pattern='Run retains proof failure diagnostics|public runIssue reaches review-ready only|missing retained reviewer authority|trusted feedback preserves exact Implement|credential-bearing Review target' /tmp/codex-rewrite-lifecycle-dist/test/v2-run-issue.test.js; затем node --test --test-name-pattern='public runIssue reaches review-ready only' /tmp/codex-rewrite-lifecycle-dist/test/v2-run-issue.test.js`
Notes: Все пять целевых cases passed: 4 в первом прогоне; canonical effectId expectation исправлен и public case повторно passed. Три фазы feedback replay проверены после настоящего сбоя сохранения terminal state.

**public runIssue reaches review-ready only after ordered durable checks, proof, and publication**

Факт: На747 indexOf('state:publication-watermark') < indexOf('git:commit') проходит при -1 слева. Такого event нет: traceStore на5078 пишет только state:<lifecycle>:<pendingEffect>; watermark отсутствует и в текущем src.

Сохранить: Public lifecycle и durable commit intent до реального commit; ordered external effects сохранять.

Исправление: Заменить устаревший assertion проверкой persisted exact initial-commit intent внутри createOrObserveCommit wrapper либо удалить assertion как устаревший при сохранении assertSubsequence; event-order helper должен проверять наличие обоих событий.

### P2 · [test/v2-run-issue.test.ts:1097](../../test/v2-run-issue.test.ts#L1097)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-run-issue.test.ts
Validation: `node --test --test-name-pattern='Run retains proof failure diagnostics|public runIssue reaches review-ready only|missing retained reviewer authority|trusted feedback preserves exact Implement|credential-bearing Review target' /tmp/codex-rewrite-lifecycle-dist/test/v2-run-issue.test.js; затем node --test --test-name-pattern='public runIssue reaches review-ready only' /tmp/codex-rewrite-lifecycle-dist/test/v2-run-issue.test.js`
Notes: Все пять целевых cases passed: 4 в первом прогоне; canonical effectId expectation исправлен и public case повторно passed. Три фазы feedback replay проверены после настоящего сбоя сохранения terminal state.

**missing retained reviewer authority stops as a Runner error without requesting another report**

Факт: На1108 includes('push') всегда false: traceGit пишет git:push.

Сохранить: Fail-closed при потерянной reviewer authority без нового report/publication.

Исправление: Проверять git:push и effect:pr/remote branch absence, сохранив result/state/review count.

### P2 · [test/v2-run-issue.test.ts:2064](../../test/v2-run-issue.test.ts#L2064)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-run-issue.test.ts
Validation: `node --test --test-name-pattern='Run retains proof failure diagnostics|public runIssue reaches review-ready only|missing retained reviewer authority|trusted feedback preserves exact Implement|credential-bearing Review target' /tmp/codex-rewrite-lifecycle-dist/test/v2-run-issue.test.js; затем node --test --test-name-pattern='public runIssue reaches review-ready only' /tmp/codex-rewrite-lifecycle-dist/test/v2-run-issue.test.js`
Notes: Все пять целевых cases passed: 4 в первом прогоне; canonical effectId expectation исправлен и public case повторно passed. Три фазы feedback replay проверены после настоящего сбоя сохранения terminal state.

**trusted feedback preserves exact Implement, Proof, and rejected Review blockers across outcome-evidence replay**

Факт: Название обещает outcome-evidence replay, но сбой evidence/store не инжектируется. Implementation/proof ветки вызывают RunIssue один раз. workCalls на2157 снимается после последнего run и на2168 сравнивается без нового вызова: тавтология. Review второй раз вызывается для report correction, не outcome-evidence replay.

Сохранить: Exact Implement/Proof/Review blocker mapping для активного feedback и отсутствие повторного work при recovery.

Исправление: Инжектировать terminal-state/evidence fault; проверить pendingEffect outcome-evidence, снять counts до нового RunIssue(...).runIssue(), затем сравнить exact blocker/state и отсутствие agent/proof/review/push.

### P2 · [test/v2-run-issue.test.ts:3083](../../test/v2-run-issue.test.ts#L3083)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-run-issue.test.ts
Validation: `node --test --test-name-pattern='Run retains proof failure diagnostics|public runIssue reaches review-ready only|missing retained reviewer authority|trusted feedback preserves exact Implement|credential-bearing Review target' /tmp/codex-rewrite-lifecycle-dist/test/v2-run-issue.test.js; затем node --test --test-name-pattern='public runIssue reaches review-ready only' /tmp/codex-rewrite-lifecycle-dist/test/v2-run-issue.test.js`
Notes: Все пять целевых cases passed: 4 в первом прогоне; canonical effectId expectation исправлен и public case повторно passed. Три фазы feedback replay проверены после настоящего сбоя сохранения terminal state.

**credential-bearing Review target blocks durably instead of retrying transport**

Факт: На3091 event === 'push' не совпадает с git:push; отрицательная проверка publication мертва.

Сохранить: Credential containment, durable blocked outcome и отсутствие proof/Review/publication.

Исправление: Проверять git:push и effect:pr/remote branch absence; security assertions оставить.

## Keep temporarily — не удалять до замены

Оба case защищают реальную process/crash boundary. Удаление сейчас ослабит проверку cleanup или сохранности journal; сначала добавить ограниченные ожидания и гарантированную очистку. Зависание — подтверждённый путь по коду, фактическое зависание текущего прогона не заявляется.

### P1 · [test/v2-check-runtime.test.ts:103](../../test/v2-check-runtime.test.ts#L103)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-check-runtime.test.ts
Validation: `node --test --test-concurrency=2 /tmp/codex-rewriter-root-build/test/v2-{check-runtime,cli,config-contract,gh-pull-request-adapter,pending-effect-settlement,run-store,only-contract,report-contracts}.test.js; затем node --test /tmp/codex-rewriter-root-build/test/v2-check-runtime.test.js`
Notes: 86/87 в первом прогоне; соседний Jest-selection case упёрся в нерелевантный этому контракту 5s launch budget. После увеличения только fixture command budget до 30s весь check-runtime прошёл 11/11. Все изменённые проверки подтверждены. Три изолированные мутации guards (confirmed/diverged effects, duplicate proof IDs) обнаружены.

**cancelled check proves a TERM-ignoring descendant is absent before returning**

Факт: Цикл ожидания child.pid не имеет deadline: если marker не появится, polling не завершится. Rejection check не наблюдается сразу и может вместо этого завершить процесс как unhandled rejection. После регрессии cleanup тест также не имеет собственного finally для потомка.

Сохранить: После cancellation TERM-ignoring потомок должен отсутствовать.

Исправление: Ограничить handshake дедлайном и test timeout, наблюдать rejection check сразу, в finally abort/await check и убрать только созданные тестом процессы и tmpdir. До замены сохранить реальную process-boundary проверку.

### P1 · [test/v2-run-store.test.ts:524](../../test/v2-run-store.test.ts#L524)

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: test/v2-run-store.test.ts
Validation: `node --test --test-concurrency=2 /tmp/codex-rewriter-root-build/test/v2-{check-runtime,cli,config-contract,gh-pull-request-adapter,pending-effect-settlement,run-store,only-contract,report-contracts}.test.js; затем node --test /tmp/codex-rewriter-root-build/test/v2-check-runtime.test.js`
Notes: 86/87 в первом прогоне; соседний Jest-selection case упёрся в нерелевантный этому контракту 5s launch budget. После увеличения только fixture command budget до 30s весь check-runtime прошёл 11/11. Все изменённые проверки подтверждены. Три изолированные мутации guards (confirmed/diverged effects, duplicate proof IDs) обнаружены.

**migration resumes after a killed writer and preserves the original journal**

Факт: Ожидание once(child, message) не ограничено временем и не соревнуется с exit/error; дочерний процесс держит setInterval. Если checkpoint не достигнут, тест может зависнуть навсегда. fresh child также ожидается без deadline.

Сохранить: Миграция переживает настоящий SIGKILL на каждой границе и сохраняет исходный journal.

Исправление: Дедлайн handshake с message/exit/error, bounded child execution, finally kill+await close для обоих процессов. Сохранить все четыре crashPoint, exact backup и identity assertions.

## Delete candidates

**0.** Пустых arithmetic/DI-existence тестов и доказанных полностью бесполезных cases не обнаружено. В `run-issue:701` можно убрать один мёртвый assertion после проверки соседнего ordering contract; это не основание удалять весь тест.

## Дополнительные проблемы test harness, вне счётчика test cases

Status: rewritten
Rewritten by: BadTestRewriter
Updated: 2026-10-15
Changed tests: `test/v2-mobile-real-gate.test.ts`, `test/v2-android-real-gate.ts`, `test/v2-ios-real-gate.ts`
Validation: `node --test --test-concurrency=1 /tmp/codex-proof-rewrite-runtime/test/*.test.js` — 84/84 passed, включая оба helper subprocesses.
Notes: используется реальный parsed `startedAt`; обе old-date мутации принимают stale fixture и воспроизводимо ломают новые тесты. Реальные устройства не запускались.

- **P1 · `test/v2-android-real-gate.ts:118` и `test/v2-ios-real-gate.ts:82`:** оба helper читают обязательный `--started-at` (:14/:17), но передают в `AcceptanceProof.proveChange` постоянное `proofStartedAt: 2026-07-16T12:00:00.000Z`. Проверка mtime в `src/v2/acceptance-proof.ts:448` поэтому может принять artifacts, старые относительно текущего запуска. Сохранить lease/artifact validation и передавать фактический `startedAt`; добавить отрицательный локальный case с mtime между фиксированной датой и текущим стартом. Не запускать реальные устройства для такой проверки. Это подтверждённый дефект harness, а не доказанная ошибка production Runner.

- `mission-test-temp.ts` — helper без test cases, удаляет зарегистрированные временные корни при process exit; не классифицируется как пустой тест. `self-recovery-runner.ts` — fixture worker с реальным Git/store и fake remote/agents: доказывает RunIssue recovery, но не настоящую GitHub/provider integration.

## Покрытие каждого файла

Значения ниже — статические объявления, не количество итераций параметризованных сценариев.

| Файл | Статус | Всего | Good | Rewrite | Delete | Keep temporarily | Что защищают хорошие cases |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| [test/v2-acceptance-proof.test.ts](../../test/v2-acceptance-proof.test.ts) | mixed | 17 | 16 | 1 | 0 | 0 | Binding/freshness, typed proof outcomes, report repair, custody и фильтрация публикуемого evidence. |
| [test/v2-active-attempt.test.ts](../../test/v2-active-attempt.test.ts) | good | 10 | 10 | 0 | 0 | 0 | Стадии durable attempt, PID reuse, incarnation, различие unknown/absent identity и cleanup gate. |
| [test/v2-android-lease.test.ts](../../test/v2-android-lease.test.ts) | good | 3 | 3 | 0 | 0 | 0 | Durable lease/preparation, отказ при foreign ownership, идемпотентная повторная очистка. |
| [test/v2-android-proof-runner.test.ts](../../test/v2-android-proof-runner.test.ts) | mixed | 11 | 10 | 1 | 0 | 0 | Runner-owned APK/emulator/lease, login binding, symlink containment, безопасная очистка и bounded capture. |
| [test/v2-android-proof.test.ts](../../test/v2-android-proof.test.ts) | good | 7 | 7 | 0 | 0 | 0 | Обязательные Android artifacts, lease verification/release, tamper/freshness и redaction. |
| [test/v2-browser-proof.test.ts](../../test/v2-browser-proof.test.ts) | good | 4 | 4 | 0 | 0 | 0 | Visual schema и реальный localhost browser → screenshots/DOM → AcceptanceProof; отказ при недействительных artifacts. |
| [test/v2-check-runtime.test.ts](../../test/v2-check-runtime.test.ts) | mixed | 11 | 9 | 1 | 0 | 1 | Публичный запуск check: narrowing policy, process quiescence, запуск после ownership, Flutter preparation, byte-bounded output. |
| [test/v2-cli-daemon.test.ts](../../test/v2-cli-daemon.test.ts) | good | 10 | 10 | 0 | 0 | 0 | Повторное discovery/config binding, serial progression, cancellation, reauthorization и изоляция ошибок. |
| [test/v2-cli.test.ts](../../test/v2-cli.test.ts) | mixed | 16 | 15 | 1 | 0 | 0 | Публичные CLI intent/result/exit, daemon continuation, deduplication и обработка ошибок вывода. |
| [test/v2-code-review-report.test.ts](../../test/v2-code-review-report.test.ts) | good | 11 | 11 | 0 | 0 | 0 | Валидация публичного review report: verdict, identities, revisions, coverage, defects и repair outcomes. |
| [test/v2-codex-process.test.ts](../../test/v2-codex-process.test.ts) | mixed | 26 | 25 | 1 | 0 | 0 | Containment argv/env, authority/launch gate, настоящий subprocess, timeout/cancellation и доказанная quiescence. |
| [test/v2-command-adapter.test.ts](../../test/v2-command-adapter.test.ts) | good | 1 | 1 | 0 | 0 | 0 | Реальный subprocess не может превысить допустимый объём buffered output. |
| [test/v2-config-contract.test.ts](../../test/v2-config-contract.test.ts) | mixed | 6 | 5 | 1 | 0 | 0 | Строгая config schema, публичный словарь команд/статусов и безопасный Android recipe. |
| [test/v2-contained-report-operation.test.ts](../../test/v2-contained-report-operation.test.ts) | mixed | 12 | 11 | 1 | 0 | 0 | Связь attempt/report, durable launch ordering, malformed/secret reports и fail-closed worktree inspection. |
| [test/v2-delivery-authority.test.ts](../../test/v2-delivery-authority.test.ts) | good | 2 | 2 | 0 | 0 | 0 | Immutable issue/label binding; неподдерживаемая authority отвергается. |
| [test/v2-direct-delivery.test.ts](../../test/v2-direct-delivery.test.ts) | good | 6 | 6 | 0 | 0 | 0 | Targeted repair сохраняет правильную revision/coverage history и не вводит semantic count limits. |
| [test/v2-gh-cli.test.ts](../../test/v2-gh-cli.test.ts) | good | 14 | 14 | 0 | 0 | 0 | Retry только reads, bounded deadlines/cancellation, полные страницы и отсутствие повторов writes. |
| [test/v2-gh-issue-adapter.test.ts](../../test/v2-gh-issue-adapter.test.ts) | good | 12 | 12 | 0 | 0 | 0 | REST/GraphQL → domain DTO: точные большие IDs, timestamps, permission identity, truncation/Unicode, pagination и cancellation. |
| [test/v2-gh-pull-request-adapter.test.ts](../../test/v2-gh-pull-request-adapter.test.ts) | mixed | 7 | 6 | 1 | 0 | 0 | Repository/head-bound PR/review DTO, полные threads/comments/reviews, nullable actors и malformed payload отказ. |
| [test/v2-git-base.test.ts](../../test/v2-git-base.test.ts) | good | 2 | 2 | 0 | 0 | 0 | Настоящий локальный Git: свежий remote base и создание worktree из pinned SHA. |
| [test/v2-github-authorization.test.ts](../../test/v2-github-authorization.test.ts) | good | 3 | 3 | 0 | 0 | 0 | Fresh GitHub grant относительно immutable outcome evidence; revoked/conflicting labels не дают authority. |
| [test/v2-immutable-workflow-publisher.test.ts](../../test/v2-immutable-workflow-publisher.test.ts) | good | 1 | 1 | 0 | 0 | 0 | Неизвестная identity publisher сохраняет exact claim bytes и не разрешает замену содержимого. |
| [test/v2-implementation-reviewer.test.ts](../../test/v2-implementation-reviewer.test.ts) | good | 13 | 13 | 0 | 0 | 0 | Review request/report/capsule, process binding, correction/recovery и независимая reviewer authority. |
| [test/v2-ios-lease.test.ts](../../test/v2-ios-lease.test.ts) | mixed | 8 | 7 | 1 | 0 | 0 | Exact Simulator/bundle/PID ownership, intent/bind/verify/release и interrupted cleanup recovery. |
| [test/v2-ios-proof.test.ts](../../test/v2-ios-proof.test.ts) | good | 2 | 2 | 0 | 0 | 0 | Lease-bound iOS visual evidence, verifier/release и отсутствие host identity в public receipt. |
| [test/v2-ios-runtime.test.ts](../../test/v2-ios-runtime.test.ts) | good | 2 | 2 | 0 | 0 | 0 | Выбор доступного runtime/device; release адресует только exact UDID и подтверждает удаление. |
| [test/v2-issue-check-policy.test.ts](../../test/v2-issue-check-policy.test.ts) | good | 1 | 1 | 0 | 0 | 0 | Публичный parser возвращает argv и отвергает shell chaining; это не пустая проверка существования экспорта. |
| [test/v2-issue-proof-policy.test.ts](../../test/v2-issue-proof-policy.test.ts) | good | 2 | 2 | 0 | 0 | 0 | Tests-only/android-live discriminants, authenticated steps и отказ при двусмысленном/downgraded contract. |
| [test/v2-live-smoke-script.test.ts](../../test/v2-live-smoke-script.test.ts) | mixed | 37 | 15 | 22 | 0 | 0 | CLI argument/help validation, registry/profile metadata и исполняемые wrapper self-tests; статический текст признан good только как декларативный контракт. |
| [test/v2-only-contract.test.ts](../../test/v2-only-contract.test.ts) | mixed | 2 | 1 | 1 | 0 | 0 | Package entrypoints/files/build-clean contract защищает границу поставки пакета. |
| [test/v2-owner-control-lock.test.ts](../../test/v2-owner-control-lock.test.ts) | good | 9 | 9 | 0 | 0 | 0 | Token-safe serialization, PID reuse/foreign host fail-closed, durable concurrent command fences и настоящий crash. |
| [test/v2-package-consumer.test.ts](../../test/v2-package-consumer.test.ts) | good | 1 | 1 | 0 | 0 | 0 | Настоящий npm pack/install и TypeScript consumers выявляют сломанные декларации/экспорты/зависимости пакета. |
| [test/v2-pending-effect-settlement.test.ts](../../test/v2-pending-effect-settlement.test.ts) | mixed | 5 | 3 | 2 | 0 | 0 | Идемпотентность эффекта, наблюдение postcondition, неизвестная доставка и отказ при неправильном kind. |
| [test/v2-process-deadline.test.ts](../../test/v2-process-deadline.test.ts) | good | 5 | 5 | 0 | 0 | 0 | Настоящие processes/streams/stdin и OS errors: deadline и отсутствие ложной quiescence. |
| [test/v2-remote-base.test.ts](../../test/v2-remote-base.test.ts) | good | 1 | 1 | 0 | 0 | 0 | Пять локальных Git сценариев: dirty target сохраняется, exact remote tree, cleanup и moving-base/fetch/hook failures. |
| [test/v2-report-contracts.test.ts](../../test/v2-report-contracts.test.ts) | mixed | 16 | 14 | 2 | 0 | 0 | Строгие agent/proof schemas, status/feedback discriminants, credential/path/byte bounds и cross-reference validation. |
| [test/v2-review-feedback-contract.test.ts](../../test/v2-review-feedback-contract.test.ts) | good | 6 | 6 | 0 | 0 | 0 | Детерминированный freeze/hash, append-only source consumption, trusted body/receipt binding и projection. |
| [test/v2-review-feedback-coordinator.test.ts](../../test/v2-review-feedback-coordinator.test.ts) | good | 12 | 12 | 0 | 0 | 0 | Trust/cutoff/head/permission observations, paginated authority, torn snapshots и source revalidation. |
| [test/v2-run-issue.test.ts](../../test/v2-run-issue.test.ts) | mixed | 164 | 159 | 5 | 0 | 0 | Public RunIssue с локальным Git и persisted state: authority, candidate/check/proof/review binding, finite effects и restart/repair/notification contracts. |
| [test/v2-run-store.test.ts](../../test/v2-run-store.test.ts) | mixed | 24 | 23 | 0 | 0 | 1 | CAS и exact bytes, strict/legacy schemas, lock/token/symlink safety, per-issue journals, hashed histories и migration recovery. |
| [test/v2-runtime-assets.test.ts](../../test/v2-runtime-assets.test.ts) | good | 18 | 18 | 0 | 0 | 0 | Immutable workflow assets/generation/cache, integrity, lock/restart preservation и package-owned runtime boundaries. |
| [test/v2-runtime-codex.test.ts](../../test/v2-runtime-codex.test.ts) | good | 8 | 8 | 0 | 0 | 0 | Production adapter wiring, containment/process ownership и typed outcomes через настоящий adapter seam. |
| [test/v2-self-recovery-restart.test.ts](../../test/v2-self-recovery-restart.test.ts) | good | 4 | 4 | 0 | 0 | 0 | Настоящий SIGKILL/restart на lifecycle/effect границах; exact run/tree identity и отсутствие повторной успешной работы. |
| [test/v2-setup-cli.test.ts](../../test/v2-setup-cli.test.ts) | good | 2 | 2 | 0 | 0 | 0 | Публичный setup/doctor/status parser и typed JSON/exit outcomes. |
| [test/v2-setup-runtime.test.ts](../../test/v2-setup-runtime.test.ts) | good | 1 | 1 | 0 | 0 | 0 | Настоящая production Setup composition выбирает origin/HEAD и повторно не меняет config. |
| [test/v2-setup.test.ts](../../test/v2-setup.test.ts) | good | 11 | 11 | 0 | 0 | 0 | Setup outcomes + filesystem state: zero-write dry-run, labels, symlink containment, repeat configure и publication fault recovery. |
| [test/v2-validation-progression.test.ts](../../test/v2-validation-progression.test.ts) | good | 7 | 7 | 0 | 0 | 0 | Публичные validation transitions и CAS guard отвергают stale identity до writer; repair очищает привязанные результаты. |
| [test/v2-workflow-assets.test.ts](../../test/v2-workflow-assets.test.ts) | good | 13 | 13 | 0 | 0 | 0 | Декларативные packaged instructions/schema/eval contracts и корректность generated inventory. |
| [test/v2-workflow-import.test.ts](../../test/v2-workflow-import.test.ts) | good | 7 | 7 | 0 | 0 | 0 | Workflow importer/sync/verify: воспроизводимые assets, no ambient paths, bounds, symlinks и exact generated bytes. |
| [test/v2-worktree-recovery.test.ts](../../test/v2-worktree-recovery.test.ts) | good | 2 | 2 | 0 | 0 | 0 | Настоящий Git сохраняет неизвестную materialization; owned command deadline ограничивает зависшее inspection. |
| [test/fixtures/v2-mobile-fixture/test/widget_test.dart](../../test/fixtures/v2-mobile-fixture/test/widget_test.dart) | good | 1 | 1 | 0 | 0 | 0 | Настоящий widget tap переводит waiting → platform proof ready; фикстура нужна proof-сценариям. |
| [test/fixtures/v2-mobile-fixture/configure_ios_ui_test.rb](../../test/fixtures/v2-mobile-fixture/configure_ios_ui_test.rb) | good | 1 | 1 | 0 | 0 | 0 | Generated XCTest выполняет launch/tap, bounded accessibility ожидание iOS proof ready и выдаёт hierarchy для proof; sleep после READY оставляет окно для внешнего capture. |

Дополнительные четыре helper-файла прочитаны полностью; helper findings перечислены выше. Generated `dist/`, dependencies и static workflow eval YAML не считаются отдельными исполняемыми тестовыми файлами. Их schema/inventory проверяется package tests.

## Классификация каждого объявления

Каждая строка — проверенный case с точным местом. Для `good` основание указано в последнем столбце таблицы файлов выше; название уточняет защищаемое поведение. Для остальных полный дефект и безопасная замена приведены в разделах Rewrite / Keep temporarily.

### test/v2-acceptance-proof.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [25](../../test/v2-acceptance-proof.test.ts#L25) | good | proof failure receipts retain the bounded cause for input, inspection, agent, and artifact failures |
| [48](../../test/v2-acceptance-proof.test.ts#L48) | good | proof failure detail is bounded and sensitive text is redacted before truncation |
| [71](../../test/v2-acceptance-proof.test.ts#L71) | good | CheckedChange is nominal at compile time and rejects forged runtime objects |
| [87](../../test/v2-acceptance-proof.test.ts#L87) | good | CheckedChange V2 binds every receipt and changed path to one candidate while V1 remains index-based |
| [143](../../test/v2-acceptance-proof.test.ts#L143) | good | caller-owned passed receipt prevents a duplicate attempt while binding mismatch fails before launch |
| [160](../../test/v2-acceptance-proof.test.ts#L160) | good | stale HEAD/index/tracked/untracked/worktree/check-policy fails before proof effects |
| [178](../../test/v2-acceptance-proof.test.ts#L178) | good | freshness is rechecked after proof and stale checked input cannot be accepted as passed |
| [191](../../test/v2-acceptance-proof.test.ts#L191) | good | malformed report, rewritten criteria, and unsafe report paths request one explicit caller-owned report repair |
| [218](../../test/v2-acceptance-proof.test.ts#L218) | good | forbidden proof diff fails closed without format repair |
| [231](../../test/v2-acceptance-proof.test.ts#L231) | good | host identity filtering applies only to publishable artifacts |
| [252](../../test/v2-acceptance-proof.test.ts#L252) | good | report repair and transport retry remain resumable without semantic exhaustion |
| [305](../../test/v2-acceptance-proof.test.ts#L305) | good | resumable proof retains the exact process cause alongside the checked candidate |
| [311](../../test/v2-acceptance-proof.test.ts#L311) | good | passed proof returns only a sanitized receipt and has no hidden lifecycle dependency |
| [328](../../test/v2-acceptance-proof.test.ts#L328) | good | passed receipt remains monotonic when mobile lease cleanup must be retried |
| [348](../../test/v2-acceptance-proof.test.ts#L348) | good | caller-owned passed receipt is strictly validated before reuse |
| [359](../../test/v2-acceptance-proof.test.ts#L359) | good | needs-rework, external-block, transport, cancellation, and internal agent outcomes remain typed |
| [553](../../test/v2-acceptance-proof.test.ts#L553) | rewrite | explicit live Android proof rejects non-visual acceptance |

### test/v2-active-attempt.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [23](../../test/v2-active-attempt.test.ts#L23) | good | one active attempt moves through launch observation adoption cleanup and clear |
| [64](../../test/v2-active-attempt.test.ts#L64) | good | missing result cannot be adopted or replaced until cleanup is confirmed |
| [82](../../test/v2-active-attempt.test.ts#L82) | good | a replacement incarnation receives a distinct attempt and result identity |
| [95](../../test/v2-active-attempt.test.ts#L95) | good | default preparation creates a fresh incarnation for the same semantic operation |
| [106](../../test/v2-active-attempt.test.ts#L106) | good | Darwin process identity never proves same and requires old group absence |
| [125](../../test/v2-active-attempt.test.ts#L125) | good | Linux start ticks distinguish same process from PID reuse |
| [138](../../test/v2-active-attempt.test.ts#L138) | good | Linux launch capture and recovery read exact /proc start ticks and process group |
| [166](../../test/v2-active-attempt.test.ts#L166) | good | portable observation distinguishes absence, PID reuse, and unreadable identity |
| [189](../../test/v2-active-attempt.test.ts#L189) | good | Darwin launch stores unavailable sentinel while recovery stays fail-closed |
| [215](../../test/v2-active-attempt.test.ts#L215) | good | process-group observation is independent and fail-closed |

### test/v2-android-lease.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [11](../../test/v2-android-lease.test.ts#L11) | good | durable Android release retries failed stop and removes host resources while retaining proof evidence |
| [46](../../test/v2-android-lease.test.ts#L46) | good | missing Android lease cannot report cleanup complete while preparation resources remain |
| [57](../../test/v2-android-lease.test.ts#L57) | good | durable cleanup recovers a booting owned emulator before lease creation and preserves a foreign preparation |

### test/v2-android-proof-runner.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [23](../../test/v2-android-proof-runner.test.ts#L23) | rewrite | runner owns an isolated emulator and enforces ${loginState} proof |
| [171](../../test/v2-android-proof-runner.test.ts#L171) | good | runner owns lease creation and terminal release stops only its emulator |
| [209](../../test/v2-android-proof-runner.test.ts#L209) | good | runner release is idempotent and never kills a foreign emulator after serial reuse |
| [235](../../test/v2-android-proof-runner.test.ts#L235) | good | runner retains lease ownership when process identity inspection fails |
| [255](../../test/v2-android-proof-runner.test.ts#L255) | good | runner refuses a stale APK when the configured build produces no fresh output |
| [294](../../test/v2-android-proof-runner.test.ts#L294) | good | runner never removes an APK through a symlinked worktree parent |
| [333](../../test/v2-android-proof-runner.test.ts#L333) | good | runner blocks a symlinked proof root without mutating the external target |
| [358](../../test/v2-android-proof-runner.test.ts#L358) | good | runner terminates oversized adb binary capture before buffering unbounded output |
| [399](../../test/v2-android-proof-runner.test.ts#L399) | good | runner returns a useful redacted build blocker and cleans its lease and emulator |
| [452](../../test/v2-android-proof-runner.test.ts#L452) | good | runner preserves an existing durable lease instead of starting a competing emulator |
| [491](../../test/v2-android-proof-runner.test.ts#L491) | good | failed emulator launch removes its unused data and preparation intent |

### test/v2-android-proof.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [10](../../test/v2-android-proof.test.ts#L10) | good | Android proof report requires lease-bound screenshot, UI hierarchy, device log, workflow, and analysis |
| [28](../../test/v2-android-proof.test.ts#L28) | good | AcceptanceProof verifies and releases Android ownership while returning only sanitized evidence |
| [48](../../test/v2-android-proof.test.ts#L48) | good | AcceptanceProof accepts current Runner-prepared Android artifacts without requiring the contained worker to rewrite them |
| [74](../../test/v2-android-proof.test.ts#L74) | good | AcceptanceProof persists an unfinished Android UI warning even when the worker omits it |
| [85](../../test/v2-android-proof.test.ts#L85) | good | AcceptanceProof fails closed when Android lease verification is absent or rejects ownership |
| [96](../../test/v2-android-proof.test.ts#L96) | good | AcceptanceProof rejects secret-bearing Android device logs before lease acceptance |
| [110](../../test/v2-android-proof.test.ts#L110) | good | AcceptanceProof rejects stale Android state and retains custody for caller-owned report repair |

### test/v2-browser-proof.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [14](../../test/v2-browser-proof.test.ts#L14) | good | browser proof report requires criterion-linked responsive screenshots, DOM state, diagnostics, and analysis |
| [35](../../test/v2-browser-proof.test.ts#L35) | good | non-visual reports forbid visual evidence and browser reports require it |
| [47](../../test/v2-browser-proof.test.ts#L47) | good | actual changed localhost workflow passes through AcceptanceProof with fresh responsive browser evidence |
| [134](../../test/v2-browser-proof.test.ts#L134) | good | AcceptanceProof rejects stale, malformed, oversized, secret-bearing, and misclassified browser artifacts |

### test/v2-check-runtime.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [10](../../test/v2-check-runtime.test.ts#L10) | good | Jest checks select the immutable change and exclude unrelated failing suites |
| [83](../../test/v2-check-runtime.test.ts#L83) | good | timed-out check proves a TERM-ignoring descendant is absent before returning |
| [103](../../test/v2-check-runtime.test.ts#L103) | keep-temporarily | cancelled check proves a TERM-ignoring descendant is absent before returning |
| [125](../../test/v2-check-runtime.test.ts#L125) | good | normal leader exit reports a live descendant process group instead of quiescence |
| [148](../../test/v2-check-runtime.test.ts#L148) | rewrite | check command cannot execute before launched ownership persistence resolves |
| [160](../../test/v2-check-runtime.test.ts#L160) | good | rejected launched ownership persistence terminates the gated check without executing it |
| [170](../../test/v2-check-runtime.test.ts#L170) | good | Flutter checks initialize dependencies in the exact checked working directory |
| [187](../../test/v2-check-runtime.test.ts#L187) | good | Flutter verification rejects an unavailable SDK environment before executing checks |
| [199](../../test/v2-check-runtime.test.ts#L199) | good | host checks distinguish unavailable executables from ordinary check failure |
| [219](../../test/v2-check-runtime.test.ts#L219) | good | large passed and failed check logs hash the exact retained bytes with explicit truncation |
| [236](../../test/v2-check-runtime.test.ts#L236) | good | check launch persistence that never settles returns within its command deadline |

### test/v2-cli-daemon.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [23](../../test/v2-cli-daemon.test.ts#L23) | good | daemon tick discards a prior frozen list when discovery fails and rediscovers next tick |
| [51](../../test/v2-cli-daemon.test.ts#L51) | good | daemon tick observes each frozen issue once and continues after retry and safety outcomes |
| [85](../../test/v2-cli-daemon.test.ts#L85) | good | an unresolved attempt releases the issue loop so later candidates run and the next tick rediscovers |
| [112](../../test/v2-cli-daemon.test.ts#L112) | good | daemon refreshes the complete execution snapshot each tick after temporary config I/O |
| [135](../../test/v2-cli-daemon.test.ts#L135) | good | a repository config change after discovery cancels the frozen execution before effects |
| [151](../../test/v2-cli-daemon.test.ts#L151) | good | discovery picks interrupted local runs without auto and omits final safety stops |
| [164](../../test/v2-cli-daemon.test.ts#L164) | good | daemon resumes only legacy proof terminals with proven technical evidence |
| [179](../../test/v2-cli-daemon.test.ts#L179) | good | daemon cancellation ends the serial pass and skips later issue invocations |
| [193](../../test/v2-cli-daemon.test.ts#L193) | good | a fresh GitHub authorization returns a cancelled issue to the daemon queue |
| [207](../../test/v2-cli-daemon.test.ts#L207) | good | a stopped issue timeline failure does not skip another eligible issue |

### test/v2-cli.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [18](../../test/v2-cli.test.ts#L18) | good | CLI direct-execution guard canonicalizes macOS temporary path aliases |
| [27](../../test/v2-cli.test.ts#L27) | good | CLI accepts only one exact direct run intent |
| [38](../../test/v2-cli.test.ts#L38) | good | CLI passes an explicit proof retry bound to one run and rejects malformed retry intents |
| [55](../../test/v2-cli.test.ts#L55) | good | CLI renders only the typed runIssue outcome and matching exit |
| [71](../../test/v2-cli.test.ts#L71) | good | CLI reports bounded semantic repair continuation as success rather than transport failure |
| [82](../../test/v2-cli.test.ts#L82) | good | CLI renders effect-free unsupported state as the exact public result with blocked exit |
| [92](../../test/v2-cli.test.ts#L92) | good | CLI daemon accepts one absolute target and delegates the serial loop |
| [121](../../test/v2-cli.test.ts#L121) | good | daemon deduplicates auto and review candidates and suppresses unchanged review-ready output in one process |
| [148](../../test/v2-cli.test.ts#L148) | good | daemon releases a temporarily unavailable issue and resumes it after other candidates progress |
| [168](../../test/v2-cli.test.ts#L168) | good | continuous daemon retries fresh discovery after a failed tick without replaying stale candidates |
| [202](../../test/v2-cli.test.ts#L202) | good | daemon isolates thrown candidate failures and returns the greatest observed severity |
| [225](../../test/v2-cli.test.ts#L225) | good | daemon keeps completed severity and later candidates when output fails |
| [245](../../test/v2-cli.test.ts#L245) | good | daemon loop never relabels candidate or output failures as discovery failure |
| [272](../../test/v2-cli.test.ts#L272) | good | --once performs one fresh discovery and one serial pass without delaying |
| [296](../../test/v2-cli.test.ts#L296) | good | CLI delegates setup, doctor, and status policy to Setup and renders its typed result |
| [318](../../test/v2-cli.test.ts#L318) | rewrite | CLI help and version are side-effect free |

### test/v2-code-review-report.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [16](../../test/v2-code-review-report.test.ts#L16) | good | accepts an independent complete review bound to one target revision |
| [23](../../test/v2-code-review-report.test.ts#L23) | good | approval requires every workflow-declared reviewer with a fresh identity |
| [41](../../test/v2-code-review-report.test.ts#L41) | good | targeted review accepts a non-empty affected subset of workflow reviewers |
| [52](../../test/v2-code-review-report.test.ts#L52) | good | reviewer ordering uses the workflow canonical byte order |
| [64](../../test/v2-code-review-report.test.ts#L64) | good | retained malformed review can require independent reviewer evidence without its inventory |
| [72](../../test/v2-code-review-report.test.ts#L72) | good | every repair review accounts for every previous finding ID |
| [87](../../test/v2-code-review-report.test.ts#L87) | good | generated schema has no Full Closure or closure hash contract |
| [93](../../test/v2-code-review-report.test.ts#L93) | good | review arrays are byte-bounded by the contained operation rather than semantic item counts |
| [102](../../test/v2-code-review-report.test.ts#L102) | good | approved complete review must cover every Runner-required focus area |
| [116](../../test/v2-code-review-report.test.ts#L116) | good | needs-work requires an open or reopened defect or repair finding |
| [130](../../test/v2-code-review-report.test.ts#L130) | good | machine coverage rejects narrative prose and exposes the same categories in the schema |

### test/v2-codex-process.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [21](../../test/v2-codex-process.test.ts#L21) | good | builds the exact contained argv and allowlisted process environment without suppressing native subagents |
| [61](../../test/v2-codex-process.test.ts#L61) | good | live smoke default-model mode leaves model selection to Codex |
| [82](../../test/v2-codex-process.test.ts#L82) | good | live smoke explicit model overrides every packaged workflow role |
| [110](../../test/v2-codex-process.test.ts#L110) | good | contained argv rejects operation policy widening and honors a declared read-only sandbox |
| [137](../../test/v2-codex-process.test.ts#L137) | good | contained argv binds packaged reviewer profiles as executable named agents |
| [157](../../test/v2-codex-process.test.ts#L157) | good | awaits stdin, exit, process-group absence, streams, and only then reads the report |
| [171](../../test/v2-codex-process.test.ts#L171) | good | launch gate records the spawned process before stdin and terminates on rejected persistence |
| [198](../../test/v2-codex-process.test.ts#L198) | good | unknown process-start identity rejects the launch gate before persistence or stdin |
| [219](../../test/v2-codex-process.test.ts#L219) | good | classifies nonzero exit, spawn failure, and bounded-output overflow separately |
| [241](../../test/v2-codex-process.test.ts#L241) | good | classifies confirmed Codex stream disconnect without a report as transport failure |
| [259](../../test/v2-codex-process.test.ts#L259) | good | classifies model capacity refusal without a report as resumable transport failure |
| [278](../../test/v2-codex-process.test.ts#L278) | good | classifies successful Codex exit without its output report as resumable transport failure |
| [291](../../test/v2-codex-process.test.ts#L291) | good | capacity diagnostics do not mask an available report or an unrelated process failure |
| [308](../../test/v2-codex-process.test.ts#L308) | good | wall timeout terminates the group and escalates to SIGKILL before returning |
| [323](../../test/v2-codex-process.test.ts#L323) | rewrite | idle timeout is reset by stream activity and is distinct from wall timeout |
| [335](../../test/v2-codex-process.test.ts#L335) | good | caller cancellation uses the same quiescence barrier and returns only after streams close |
| [347](../../test/v2-codex-process.test.ts#L347) | good | normal parent exit with a detached descendant terminates the remaining group |
| [357](../../test/v2-codex-process.test.ts#L357) | good | throws typed safe-halt evidence when group absence cannot be proved after SIGTERM and SIGKILL |
| [375](../../test/v2-codex-process.test.ts#L375) | good | throws typed safe-halt evidence when streams cannot be confirmed closed |
| [387](../../test/v2-codex-process.test.ts#L387) | good | production supervisor captures output and exit from an immediately exiting child |
| [405](../../test/v2-codex-process.test.ts#L405) | good | production supervisor cannot exec Codex before the durable launch gate opens |
| [423](../../test/v2-codex-process.test.ts#L423) | good | parent-pipe closure exits an unpersisted gate without executing the child |
| [590](../../test/v2-codex-process.test.ts#L590) | good | wall deadline includes durable onSpawned persistence and never releases a hung gate |
| [602](../../test/v2-codex-process.test.ts#L602) | good | real supervised worker hung on stdin returns timeout or preserves unconfirmed group ownership |
| [639](../../test/v2-codex-process.test.ts#L639) | good | group signal permission error keeps typed ownership when reobservation stays live |
| [650](../../test/v2-codex-process.test.ts#L650) | good | real oversized service output preserves the atomic report and bounded diagnostic bytes |

### test/v2-command-adapter.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [6](../../test/v2-command-adapter.test.ts#L6) | good | production command executor aborts before buffering output beyond the configured bound |

### test/v2-config-contract.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [49](../../test/v2-config-contract.test.ts#L49) | good | V2 accepts the exact clean config and snapshots the only command, status, and label vocabulary |
| [73](../../test/v2-config-contract.test.ts#L73) | good | the checked-in package config parses through the real V2 parser |
| [82](../../test/v2-config-contract.test.ts#L82) | good | V2 rejects unknown configuration surfaces |
| [94](../../test/v2-config-contract.test.ts#L94) | good | V2 rejects invalid integers, non-canonical paths, commands, and empty policy strings |
| [108](../../test/v2-config-contract.test.ts#L108) | good | V2 accepts a strict optional Runner-owned Android proof recipe and rejects unsafe recipes |
| [145](../../test/v2-config-contract.test.ts#L145) | rewrite | CLI JSON and exit mapping are total over every public runIssue outcome |

### test/v2-contained-report-operation.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [48](../../test/v2-contained-report-operation.test.ts#L48) | good | implementation reviewer persists prepared and launched identity before accepting a correlated report |
| [71](../../test/v2-contained-report-operation.test.ts#L71) | good | Review preparation persistence I/O retries the same candidate before launching any worker |
| [88](../../test/v2-contained-report-operation.test.ts#L88) | good | Review preparation correlation or unexplained persistence failure preserves its safety stop |
| [97](../../test/v2-contained-report-operation.test.ts#L97) | good | implementation reviewer rejects missing launch persistence and stale correlation |
| [118](../../test/v2-contained-report-operation.test.ts#L118) | good | invalid payload returns validation findings without retaining raw payload bytes |
| [134](../../test/v2-contained-report-operation.test.ts#L134) | good | credential-bearing report bytes are rejected before payload adoption |
| [144](../../test/v2-contained-report-operation.test.ts#L144) | rewrite | quiescence uncertainty returns durable process evidence without an unsafe final snapshot |
| [162](../../test/v2-contained-report-operation.test.ts#L162) | good | launcher blocks authority or generation drift before starting the process |
| [180](../../test/v2-contained-report-operation.test.ts#L180) | good | temporary snapshot I/O during ${phase} remains retryable without admitting a report |
| [190](../../test/v2-contained-report-operation.test.ts#L190) | good | invalid or unexplained snapshot failure during ${phase} keeps its safety stop |
| [200](../../test/v2-contained-report-operation.test.ts#L200) | good | launcher blocks a completed report when any before/after worktree fingerprint differs |
| [286](../../test/v2-contained-report-operation.test.ts#L286) | good | missing workflow reviewer inventory blocks before launch and never becomes a report repair |

### test/v2-delivery-authority.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [14](../../test/v2-delivery-authority.test.ts#L14) | good | explicit Issue authority binds the immutable issue content and authorization label |
| [23](../../test/v2-delivery-authority.test.ts#L23) | good | planning artifacts cannot be represented as package delivery authority |

### test/v2-direct-delivery.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [25](../../test/v2-direct-delivery.test.ts#L25) | good | repair creates a targeted revision that retains the previous reviewed target |
| [51](../../test/v2-direct-delivery.test.ts#L51) | good | every later repair anchors to the immediately previous approved target without a round limit |
| [73](../../test/v2-direct-delivery.test.ts#L73) | good | targeted approval merges repaired coverage with untouched historical approval |
| [90](../../test/v2-direct-delivery.test.ts#L90) | good | persisted direct review coverage accepts 257 unique byte-bounded entries |
| [105](../../test/v2-direct-delivery.test.ts#L105) | good | more than 256 sequential repairs compact verified findings into coverage truth |
| [127](../../test/v2-direct-delivery.test.ts#L127) | good | targeted needs-work preserves untouched approval but removes blocked coverage |

### test/v2-gh-cli.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [6](../../test/v2-gh-cli.test.ts#L6) | good | GitHub issue reads recover from a temporary server failure |
| [16](../../test/v2-gh-cli.test.ts#L16) | good | GitHub reads stop after three temporary failures and retain the original error |
| [24](../../test/v2-gh-cli.test.ts#L24) | good | GitHub GraphQL mutations are not retried as reads |
| [34](../../test/v2-gh-cli.test.ts#L34) | good | explicit default-method REST GETs used by Setup participate in bounded retries |
| [46](../../test/v2-gh-cli.test.ts#L46) | good | GitHub reads never retry unresolved process ownership even with a network diagnostic |
| [54](../../test/v2-gh-cli.test.ts#L54) | good | explicit GitHub rate limits retry even when returned as HTTP 403 |
| [64](../../test/v2-gh-cli.test.ts#L64) | good | GitHub writes and permanent read errors are never retried |
| [82](../../test/v2-gh-cli.test.ts#L82) | good | cancelling GitHub retry backoff prevents another command |
| [95](../../test/v2-gh-cli.test.ts#L95) | good | GitHub retry delays share the command deadline |
| [103](../../test/v2-gh-cli.test.ts#L103) | good | paged GitHub reads retry a failed page without duplicating previous pages |
| [118](../../test/v2-gh-cli.test.ts#L118) | good | an interrupted paged read rejects instead of returning partial authority |
| [131](../../test/v2-gh-cli.test.ts#L131) | good | the collection deadline covers all pages rather than restarting per page |
| [142](../../test/v2-gh-cli.test.ts#L142) | good | default GitHub transport bounds an owned command that never exits |
| [149](../../test/v2-gh-cli.test.ts#L149) | good | owned GitHub cancellation waits for cleanup and preserves an unresolved ownership error |

### test/v2-gh-issue-adapter.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [17](../../test/v2-gh-issue-adapter.test.ts#L17) | good | GhCliIssueAdapter preserves decimal REST comment and author IDs above MAX_SAFE_INTEGER |
| [38](../../test/v2-gh-issue-adapter.test.ts#L38) | good | GhCliIssueAdapter canonicalizes GitHub comment timestamps before persistence |
| [66](../../test/v2-gh-issue-adapter.test.ts#L66) | good | GhCliIssueAdapter bounds historical comments to the persisted run-state contract |
| [78](../../test/v2-gh-issue-adapter.test.ts#L78) | good | GhCliIssueAdapter checks permission against the immutable author ID and types 404 as none |
| [99](../../test/v2-gh-issue-adapter.test.ts#L99) | good | GhCliIssueAdapter normalizes GitHub maintain permission to trusted write-equivalent |
| [111](../../test/v2-gh-issue-adapter.test.ts#L111) | good | GhCliIssueAdapter returns the posted comment only after REST reread observes it |
| [125](../../test/v2-gh-issue-adapter.test.ts#L125) | good | GhCliIssueAdapter preserves oversized Unicode comments across the GitHub argv round trip |
| [151](../../test/v2-gh-issue-adapter.test.ts#L151) | good | discovers eligible issues beyond the first thousand through bounded pages |
| [167](../../test/v2-gh-issue-adapter.test.ts#L167) | good | Runner cancellation aborts an active issue collection and never returns its first page as authority |
| [186](../../test/v2-gh-issue-adapter.test.ts#L186) | good | Runner cancellation prevents a new individual issue read or write |
| [198](../../test/v2-gh-issue-adapter.test.ts#L198) | good | GitHub authorization uses the latest auto-label event across the complete timeline |
| [209](../../test/v2-gh-issue-adapter.test.ts#L209) | good | an auto-label removal is not an authorization even when an older grant exists |

### test/v2-gh-pull-request-adapter.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [7](../../test/v2-gh-pull-request-adapter.test.ts#L7) | good | reads the authoritative head SHA from the REST pull-request snapshot |
| [19](../../test/v2-gh-pull-request-adapter.test.ts#L19) | good | reads an exact repository-bound pull request review target |
| [76](../../test/v2-gh-pull-request-adapter.test.ts#L76) | good | retries a transient failure during the GraphQL pull-request read |
| [98](../../test/v2-gh-pull-request-adapter.test.ts#L98) | good | paginates review threads and nested comments without exposing a mutation |
| [154](../../test/v2-gh-pull-request-adapter.test.ts#L154) | rewrite | reads paginated submitted reviews and pull request conversation comments with exact identities |
| [195](../../test/v2-gh-pull-request-adapter.test.ts#L195) | good | rejects malformed review payloads and preserves nullable GraphQL actors |
| [268](../../test/v2-gh-pull-request-adapter.test.ts#L268) | good | reads more than twenty pages and two thousand submitted reviews completely |

### test/v2-git-base.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [14](../../test/v2-git-base.test.ts#L14) | good | new runs resolve the configured base from a fresh remote branch |
| [40](../../test/v2-git-base.test.ts#L40) | good | issue worktrees are created from the pinned base SHA instead of a moving branch ref |

### test/v2-github-authorization.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [24](../../test/v2-github-authorization.test.ts#L24) | good | GitHub reauthorization compares a new grant with immutable outcome evidence, not journal updatedAt or comments |
| [35](../../test/v2-github-authorization.test.ts#L35) | good | GitHub event identity distinguishes a new grant within the same timestamp second |
| [44](../../test/v2-github-authorization.test.ts#L44) | good | GitHub closure, revoked/conflicting labels and absent evidence cannot authorize execution |

### test/v2-immutable-workflow-publisher.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [8](../../test/v2-immutable-workflow-publisher.test.ts#L8) | good | publisher preserves exact claim when prior process identity cannot be confirmed |

### test/v2-implementation-reviewer.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [23](../../test/v2-implementation-reviewer.test.ts#L23) | good | complete and targeted Review launch with the exact 19207-character candidate patch |
| [40](../../test/v2-implementation-reviewer.test.ts#L40) | good | Review passes large exact capsules through Runner-owned files without truncating patches |
| [57](../../test/v2-implementation-reviewer.test.ts#L57) | good | thin reviewer facade binds an independent attempt and delegates durable launch hooks |
| [87](../../test/v2-implementation-reviewer.test.ts#L87) | good | targeted reviewer capsule carries only ephemeral exact trees, patch, blocker IDs, and current proof |
| [114](../../test/v2-implementation-reviewer.test.ts#L114) | good | report-only repair requires exact bounded secret-free original bytes and a new attempt |
| [149](../../test/v2-implementation-reviewer.test.ts#L149) | good | coverage-only correction retains independent verdicts and cannot erase findings or replace reviewers |
| [173](../../test/v2-implementation-reviewer.test.ts#L173) | good | malformed Review admission has one exact encoded capsule boundary and every admitted result can be repaired |
| [212](../../test/v2-implementation-reviewer.test.ts#L212) | good | production reviewer accepts targeted and complete fallback capsules with the same previous target provenance |
| [236](../../test/v2-implementation-reviewer.test.ts#L236) | good | reviewer capsule round-trips 257 unique input items under the encoded byte boundary |
| [247](../../test/v2-implementation-reviewer.test.ts#L247) | good | reviewer facade rejects identity reuse before launching an operation |
| [257](../../test/v2-implementation-reviewer.test.ts#L257) | good | reviewer facade projects settled launch-gate failure as resumable infrastructure |
| [264](../../test/v2-implementation-reviewer.test.ts#L264) | good | actual contained Review operation maps temporary snapshots, preparation, launch, and report availability as resumable |
| [305](../../test/v2-implementation-reviewer.test.ts#L305) | good | reviewer facade retains unsafe snapshot failures as integrity errors |

### test/v2-ios-lease.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [13](../../test/v2-ios-lease.test.ts#L13) | good | iOS lease helper creates a new Simulator after ownership intent, binds exact app PID, verifies, and releases it |
| [41](../../test/v2-ios-lease.test.ts#L41) | good | iOS lease helper refuses acquisition when any Simulator is already booted |
| [53](../../test/v2-ios-lease.test.ts#L53) | good | iOS lease helper refuses a live foreign lease without creating or deleting a Simulator |
| [66](../../test/v2-ios-lease.test.ts#L66) | good | iOS lease helper reclaims only an expired dead-owner target before creating a fresh target |
| [83](../../test/v2-ios-lease.test.ts#L83) | good | iOS lease helper rejects app PID drift after exact bundle observation |
| [97](../../test/v2-ios-lease.test.ts#L97) | good | runner iOS verifier matches exact ownership, invokes exact target release, and settles the local record |
| [131](../../test/v2-ios-lease.test.ts#L131) | rewrite | runner iOS verifier rejects target identity drift and an expired or unbound lease |
| [163](../../test/v2-ios-lease.test.ts#L163) | good | runner iOS release replays after target deletion and a locally released artifact |

### test/v2-ios-proof.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [10](../../test/v2-ios-proof.test.ts#L10) | good | iOS proof report requires lease-bound screenshot, accessibility hierarchy, device log, workflow, and analysis |
| [26](../../test/v2-ios-proof.test.ts#L26) | good | AcceptanceProof verifies and releases iOS ownership while returning only sanitized evidence |

### test/v2-ios-runtime.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [10](../../test/v2-ios-runtime.test.ts#L10) | good | iOS tooling discovery is read-only and selects the newest available runtime and Pro iPhone |
| [35](../../test/v2-ios-runtime.test.ts#L35) | good | iOS release controller mutates only the exact recorded UDID and confirms deletion |

### test/v2-issue-check-policy.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [7](../../test/v2-issue-check-policy.test.ts#L7) | good | package publicly exports the existing issue check invocation parser |

### test/v2-issue-proof-policy.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [8](../../test/v2-issue-proof-policy.test.ts#L8) | good | frozen issues select tests-only or a concrete authenticated Android workflow |
| [16](../../test/v2-issue-proof-policy.test.ts#L16) | good | ambiguous and downgraded proof contracts fail closed |

### test/v2-live-smoke-script.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [42](../../test/v2-live-smoke-script.test.ts#L42) | good | live smoke help pins the V2 scenario and profile matrix |
| [50](../../test/v2-live-smoke-script.test.ts#L50) | rewrite | V2 regression profile covers each supplemental non-mobile behavior once |
| [65](../../test/v2-live-smoke-script.test.ts#L65) | good | live smoke omits legacy scenario aliases without distinct V2 behavior |
| [76](../../test/v2-live-smoke-script.test.ts#L76) | rewrite | authoritative candidate smoke proves mixed-index capture and exact publication cleanup |
| [88](../../test/v2-live-smoke-script.test.ts#L88) | rewrite | default core release proves package delivery and post-PR targeted repair |
| [97](../../test/v2-live-smoke-script.test.ts#L97) | good | live smoke rejects unknown profile before package or GitHub work |
| [104](../../test/v2-live-smoke-script.test.ts#L104) | good | generated fake agent emits exact V2 implementation, code-review, and proof reports without GitHub work |
| [110](../../test/v2-live-smoke-script.test.ts#L110) | good | generated live Codex wrapper pins Luna, records the invocation, and injects faults after it |
| [116](../../test/v2-live-smoke-script.test.ts#L116) | good | fixture-specific mobile gates are not misrepresented as GitHub live smoke scenarios |
| [122](../../test/v2-live-smoke-script.test.ts#L122) | rewrite | packed smoke resolves the public V2 CLI |
| [128](../../test/v2-live-smoke-script.test.ts#L128) | good | packed smoke parses npm JSON after prepack lifecycle output |
| [142](../../test/v2-live-smoke-script.test.ts#L142) | good | live smoke executes bounded repair-ready continuations and stops at a real result boundary |
| [170](../../test/v2-live-smoke-script.test.ts#L170) | good | live smoke accepts the real repair-ready envelope and resumes bounded infrastructure outcomes |
| [200](../../test/v2-live-smoke-script.test.ts#L200) | good | authoritative smoke docs describe only current profiles, labels, and unbounded targeted repair |
| [216](../../test/v2-live-smoke-script.test.ts#L216) | rewrite | live smoke documents scratch repo and strict cleanup defaults |
| [233](../../test/v2-live-smoke-script.test.ts#L233) | rewrite | live smoke preflight is authenticated, scratch-only, and exclusively locked |
| [248](../../test/v2-live-smoke-script.test.ts#L248) | rewrite | strict cleanup removes only run-created local resources and requires complete label setup |
| [267](../../test/v2-live-smoke-script.test.ts#L267) | good | live smoke omits the redundant free-form real-codex scenario |
| [272](../../test/v2-live-smoke-script.test.ts#L272) | rewrite | every model-backed live smoke invocation pins GPT-5.6 Luna |
| [281](../../test/v2-live-smoke-script.test.ts#L281) | rewrite | live smoke starts the packaged runtime without a certification step |
| [288](../../test/v2-live-smoke-script.test.ts#L288) | rewrite | real Codex smoke budgets cover the complete multi-operation workflow |
| [294](../../test/v2-live-smoke-script.test.ts#L294) | rewrite | live code review normalization preserves the Runner capsule |
| [305](../../test/v2-live-smoke-script.test.ts#L305) | rewrite | every live code review is normalized from the runner-owned review capsule |
| [315](../../test/v2-live-smoke-script.test.ts#L315) | good | synthetic browser proof is not a GitHub live-smoke scenario |
| [323](../../test/v2-live-smoke-script.test.ts#L323) | rewrite | diagnostics uses an installed packed CLI and remains model-free |
| [333](../../test/v2-live-smoke-script.test.ts#L333) | rewrite | new regression scenarios exercise distinct owner boundaries |
| [371](../../test/v2-live-smoke-script.test.ts#L371) | rewrite | incomplete-progress retry uses a deterministic clean transport failure before the retry |
| [380](../../test/v2-live-smoke-script.test.ts#L380) | rewrite | proof rework fault discards transient proof evidence before a minimal needs-rework report |
| [394](../../test/v2-live-smoke-script.test.ts#L394) | rewrite | negative proof fault discards transient evidence before the external blocker report |
| [401](../../test/v2-live-smoke-script.test.ts#L401) | rewrite | review feedback continuation smoke proves same-PR update and effect-free replay |
| [431](../../test/v2-live-smoke-script.test.ts#L431) | rewrite | daemon continuation reads the target issue result from authoritative run state |
| [439](../../test/v2-live-smoke-script.test.ts#L439) | rewrite | daemon continuation requires exclusive scratch-repository candidate ownership |
| [450](../../test/v2-live-smoke-script.test.ts#L450) | rewrite | scenario assertions bind live smoke outcomes to their current owner behavior |
| [462](../../test/v2-live-smoke-script.test.ts#L462) | rewrite | fixture happy paths normalize proof semantics after real model invocation |
| [476](../../test/v2-live-smoke-script.test.ts#L476) | good | implementation operation resumes Implement after diagnosis and defines cumulative changedFiles |
| [484](../../test/v2-live-smoke-script.test.ts#L484) | good | strict cleanup retries eventually consistent observations before failing |
| [500](../../test/v2-live-smoke-script.test.ts#L500) | good | strict temporary cleanup removes the complete read-only run root |

### test/v2-only-contract.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [5](../../test/v2-only-contract.test.ts#L5) | good | public package points at one V2 runtime and ships no superseded assets |
| [20](../../test/v2-only-contract.test.ts#L20) | rewrite | root export barrel and public CLI expose the V2 authority |

### test/v2-owner-control-lock.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [11](../../test/v2-owner-control-lock.test.ts#L11) | good | host-global owner ref serializes distinct target clones and release is token-safe |
| [28](../../test/v2-owner-control-lock.test.ts#L28) | good | stale reclaimer cannot replace the winner after observed-old barrier |
| [75](../../test/v2-owner-control-lock.test.ts#L75) | good | dead-owner reclaim is PID-reuse resistant and live or unknown identity stays fail closed |
| [104](../../test/v2-owner-control-lock.test.ts#L104) | good | foreign host or boot ownership stays fail closed even when the recorded PID is absent |
| [116](../../test/v2-owner-control-lock.test.ts#L116) | good | durable unresolved command fence survives a dead owner and preserves repository ownership |
| [126](../../test/v2-owner-control-lock.test.ts#L126) | good | command fence permits reclaim only after positive leader and group absence |
| [140](../../test/v2-owner-control-lock.test.ts#L140) | good | failed fence persistence does not authorize release of the existing owner lock |
| [149](../../test/v2-owner-control-lock.test.ts#L149) | good | concurrent command receipts cannot release ownership before every command settles |
| [159](../../test/v2-owner-control-lock.test.ts#L159) | good | real runner crash with a durable prelaunch receipt fences a fresh runner |

### test/v2-package-consumer.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [12](../../test/v2-package-consumer.test.ts#L12) | good | packed install uses one package-owned workflow with empty or conflicting consumer skill state |

### test/v2-pending-effect-settlement.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [14](../../test/v2-pending-effect-settlement.test.ts#L14) | rewrite | every finite handler observes a confirmed postcondition without repeating the effect |
| [40](../../test/v2-pending-effect-settlement.test.ts#L40) | good | a handler invokes once only after observing absence and requires the exact postcondition |
| [54](../../test/v2-pending-effect-settlement.test.ts#L54) | good | unknown delivery retains observation-only recovery and never invokes twice after the effect landed |
| [74](../../test/v2-pending-effect-settlement.test.ts#L74) | rewrite | diverged and unobserved postconditions fail closed with the intent unchanged |
| [92](../../test/v2-pending-effect-settlement.test.ts#L92) | good | typed handlers reject the wrong finite effect kind before observation or invocation |

### test/v2-process-deadline.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [5](../../test/v2-process-deadline.test.ts#L5) | good | owned command parent exit drains and terminates inherited descendant pipes |
| [15](../../test/v2-process-deadline.test.ts#L15) | good | owned command deadline includes output callbacks after successful parent exit |
| [23](../../test/v2-process-deadline.test.ts#L23) | good | owned command deadline interrupts blocked stdin and preserves binary bytes |
| [36](../../test/v2-process-deadline.test.ts#L36) | good | owned command confirms group absence after exit races a denied cleanup signal |
| [60](../../test/v2-process-deadline.test.ts#L60) | good | owned command keeps denied group cleanup blocked until the existing barrier expires |

### test/v2-remote-base.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [16](../../test/v2-remote-base.test.ts#L16) | good | remote-base analysis excludes local edits and releases its temporary worktree: ${scenario} |

### test/v2-report-contracts.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [27](../../test/v2-report-contracts.test.ts#L27) | good | package-owned and generated code-review schemas equal the runtime schema owner |
| [160](../../test/v2-report-contracts.test.ts#L160) | good | implementation output schema and runtime validator have parity across status branches |
| [243](../../test/v2-report-contracts.test.ts#L243) | rewrite | answer-only and boundary reports require active issue feedback |
| [256](../../test/v2-report-contracts.test.ts#L256) | good | canonical overlay and immutable packaged implementation schemas equal the runtime owner |
| [266](../../test/v2-report-contracts.test.ts#L266) | good | agent output schemas use a Structured Outputs compatible root envelope |
| [287](../../test/v2-report-contracts.test.ts#L287) | good | checked-in proof workflow schema matches its TypeScript owner |
| [292](../../test/v2-report-contracts.test.ts#L292) | good | proof generation schema stays compact while runtime owns platform combinations |
| [307](../../test/v2-report-contracts.test.ts#L307) | good | contained adapters preserve malformed report bytes for owner-level validation and repair |
| [319](../../test/v2-report-contracts.test.ts#L319) | good | runtime validators enforce uniqueness omitted from the supported generation schema |
| [332](../../test/v2-report-contracts.test.ts#L332) | good | runtime validators enforce repository paths omitted from the supported generation regex subset |
| [345](../../test/v2-report-contracts.test.ts#L345) | good | generation schemas reject absolute, backslash, and trailing-slash paths without lookaround |
| [353](../../test/v2-report-contracts.test.ts#L353) | good | proof output schema covers valid terminal reports and runtime validator rejects invalid combinations |
| [398](../../test/v2-report-contracts.test.ts#L398) | good | proof generation keeps passed semantics while runtime owns remaining semantic failures |
| [414](../../test/v2-report-contracts.test.ts#L414) | good | proof runtime binds decisions to matching visual evidence omitted from the compact generation schema |
| [447](../../test/v2-report-contracts.test.ts#L447) | rewrite | proof runtime validation rejects dangling evidence, duplicate IDs, and non-canonical artifact paths |
| [462](../../test/v2-report-contracts.test.ts#L462) | good | ProofReceipt contains only sanitized references and never raw local artifact paths |

### test/v2-review-feedback-contract.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [16](../../test/v2-review-feedback-contract.test.ts#L16) | good | consumed sources are append-preserving and batch hashes are deterministic |
| [45](../../test/v2-review-feedback-contract.test.ts#L45) | good | review feedback validation rejects unknown keys and permits fourth and later rounds |
| [62](../../test/v2-review-feedback-contract.test.ts#L62) | good | review feedback history and consumed source dedup remain valid beyond old numeric caps |
| [87](../../test/v2-review-feedback-contract.test.ts#L87) | good | 257 trusted sources survive freeze persistence restart and activation without a semantic ceiling |
| [104](../../test/v2-review-feedback-contract.test.ts#L104) | good | review feedback validation binds trusted bodies and verified receipts to the active batch |
| [131](../../test/v2-review-feedback-contract.test.ts#L131) | good | projects only trusted frozen bodies into pr-review repair findings and worker input |

### test/v2-review-feedback-coordinator.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [10](../../test/v2-review-feedback-coordinator.test.ts#L10) | good | freezes the first trusted issue comment after the terminal cutoff and revalidates immutable source trust |
| [40](../../test/v2-review-feedback-coordinator.test.ts#L40) | good | excludes package-owned marker comments from observation and revalidation even for a trusted human login |
| [66](../../test/v2-review-feedback-coordinator.test.ts#L66) | good | uses numeric issue comment IDs as the authoritative cutoff even when timestamps race |
| [82](../../test/v2-review-feedback-coordinator.test.ts#L82) | good | falls back to trusted PR feedback when after-cutoff issue comments fail trust validation |
| [99](../../test/v2-review-feedback-coordinator.test.ts#L99) | good | freezes only authorized eligible review sources |
| [123](../../test/v2-review-feedback-coordinator.test.ts#L123) | good | defers torn observations to a later tick and ignores ineligible old feedback |
| [145](../../test/v2-review-feedback-coordinator.test.ts#L145) | good | one incomplete GraphQL page defers without an internal retry and succeeds on the next tick |
| [163](../../test/v2-review-feedback-coordinator.test.ts#L163) | good | real GraphQL ${paginationFailure} pagination uncertainty remains retryable |
| [192](../../test/v2-review-feedback-coordinator.test.ts#L192) | good | non-authoritative target metadata drift does not tear an otherwise stable authority observation |
| [217](../../test/v2-review-feedback-coordinator.test.ts#L217) | good | independent REST ${heads.rest[0]} and GraphQL ${heads.graphQl[0]} heads are retryable disagreement |
| [234](../../test/v2-review-feedback-coordinator.test.ts#L234) | good | authority drift during permission observation defers the whole trusted batch |
| [251](../../test/v2-review-feedback-coordinator.test.ts#L251) | good | revalidation rejects edited or revoked sources and post-push permits only derived thread state drift |

### test/v2-run-issue.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [41](../../test/v2-run-issue.test.ts#L41) | good | unknown candidate ownership reports reconciliation failure before claim and preserves the candidate |
| [60](../../test/v2-run-issue.test.ts#L60) | good | issue read failures retain the original transport reason before claim |
| [71](../../test/v2-run-issue.test.ts#L71) | good | issue read diagnostics redact credentials instead of persisting stderr secrets |
| [82](../../test/v2-run-issue.test.ts#L82) | good | terminal cancellation labels do not revoke a fresh grant arriving during comment delivery |
| [108](../../test/v2-run-issue.test.ts#L108) | good | a fresh GitHub grant resumes a cancelled Run without stale cancellation labels undoing it |
| [133](../../test/v2-run-issue.test.ts#L133) | good | a fresh GitHub grant retains the checked candidate and resumes proof without reimplementation |
| [152](../../test/v2-run-issue.test.ts#L152) | good | restart revalidates retained legacy implementation before checks with or without a fresh grant |
| [190](../../test/v2-run-issue.test.ts#L190) | good | a journal cancellation remains progress history without a fresh GitHub grant |
| [201](../../test/v2-run-issue.test.ts#L201) | good | a fresh GitHub grant survives interrupted outcome evidence at both state boundaries |
| [226](../../test/v2-run-issue.test.ts#L226) | good | a repeated terminal outcome after reauthorization receives a distinct immutable evidence path |
| [252](../../test/v2-run-issue.test.ts#L252) | good | new run persists GitHub comments through claim without leaking transport metadata |
| [265](../../test/v2-run-issue.test.ts#L265) | rewrite | Run retains proof failure diagnostics and existing candidate/workflow identity without launching Review or publication |
| [291](../../test/v2-run-issue.test.ts#L291) | good | explicit proof retry preserves the candidate and implementation while requiring fresh proof and Review |
| [328](../../test/v2-run-issue.test.ts#L328) | good | proof retry reopens a retained Review repair without losing its defect ledger |
| [350](../../test/v2-run-issue.test.ts#L350) | good | proof retry rejects a wrong run, revoked claim, changed HEAD, missing pin, and unrelated terminal without reopening |
| [377](../../test/v2-run-issue.test.ts#L377) | good | proof retry preserves the original terminal on validation uncertainty and succeeds after infrastructure recovery |
| [408](../../test/v2-run-issue.test.ts#L408) | good | proof retry retains its terminal authority even when validation diagnostics cannot be stored |
| [420](../../test/v2-run-issue.test.ts#L420) | good | continuation worktree restoration proves exact local and remote refs before creation |
| [449](../../test/v2-run-issue.test.ts#L449) | good | restart settles an exactly created continuation worktree before validation dispatch |
| [478](../../test/v2-run-issue.test.ts#L478) | good | proof freshness snapshot excludes only the configured untracked artifact root |
| [504](../../test/v2-run-issue.test.ts#L504) | good | candidate V2 ignores shared-index authority, pins the stable tree across prune, and materializes it exactly |
| [667](../../test/v2-run-issue.test.ts#L667) | good | known live owner contention requeues before labels or state |
| [673](../../test/v2-run-issue.test.ts#L673) | good | runner commit preserves the checked pre-proof index and leaves proof artifacts untracked |
| [701](../../test/v2-run-issue.test.ts#L701) | rewrite | public runIssue reaches review-ready only after ordered durable checks, proof, and publication |
| [750](../../test/v2-run-issue.test.ts#L750) | good | review-ready persists before independent bounded terminal notifications |
| [780](../../test/v2-run-issue.test.ts#L780) | good | terminal comment succeeds when managed-label reconciliation permanently fails |
| [809](../../test/v2-run-issue.test.ts#L809) | good | all terminal outcomes persist before permanent managed-label failure |
| [833](../../test/v2-run-issue.test.ts#L833) | good | active feedback terminals quiesce before persistence and tolerate permanent notification failure |
| [878](../../test/v2-run-issue.test.ts#L878) | good | blocked, internal-error, and cancelled outcomes finalize before best-effort notifications |
| [921](../../test/v2-run-issue.test.ts#L921) | good | terminal cutoff and marker remain stable across failed delivery and restart replay |
| [951](../../test/v2-run-issue.test.ts#L951) | good | terminal cutoff includes comments added after claim and survives cutoff observation failure |
| [973](../../test/v2-run-issue.test.ts#L973) | good | Issue Verification cannot replace mandatory configured checks on the final candidate |
| [995](../../test/v2-run-issue.test.ts#L995) | good | Issue Verification shell text cannot execute or block configured checks |
| [1006](../../test/v2-run-issue.test.ts#L1006) | good | rejected initial Review preserves exact decision evidence across restart |
| [1023](../../test/v2-run-issue.test.ts#L1023) | good | a check launch failure is resumable without consuming an implementation cycle |
| [1039](../../test/v2-run-issue.test.ts#L1039) | good | settled pre-launch check, proof, and Review failures clear prepared execution for the next bounded invocation |
| [1056](../../test/v2-run-issue.test.ts#L1056) | good | malformed code review returns one bounded resumable outcome before retrying the same candidate |
| [1072](../../test/v2-run-issue.test.ts#L1072) | good | retained complete review keeps its original coverage diagnostic across Runner restart |
| [1081](../../test/v2-run-issue.test.ts#L1081) | good | coverage correction retains exact original report through pre-launch and transport failure across restart |
| [1097](../../test/v2-run-issue.test.ts#L1097) | rewrite | missing retained reviewer authority stops as a Runner error without requesting another report |
| [1111](../../test/v2-run-issue.test.ts#L1111) | good | repeated malformed review retains report correction across ordinary Runner restarts |
| [1127](../../test/v2-run-issue.test.ts#L1127) | good | incoherent needs-work is repaired report-only instead of reaching terminal state |
| [1136](../../test/v2-run-issue.test.ts#L1136) | good | repeated runIssue replays the durable terminal outcome without a second claim or publication |
| [1148](../../test/v2-run-issue.test.ts#L1148) | good | trusted issue question answers on the same Run and PR without code, checks, proof, review, commit, or push |
| [1369](../../test/v2-run-issue.test.ts#L1369) | good | issue feedback response keeps its durable intent through ${fault} delivery failure |
| [1414](../../test/v2-run-issue.test.ts#L1414) | good | answer-only fails closed when the discovered open PR no longer matches the frozen batch identity |
| [1448](../../test/v2-run-issue.test.ts#L1448) | good | review-ready rejects a replacement open PR before feedback discovery or freezing |
| [1483](../../test/v2-run-issue.test.ts#L1483) | good | review-ready observation safety block retains the feedback baseline and history owner |
| [1503](../../test/v2-run-issue.test.ts#L1503) | good | uninitialized feedback data fails closed without losing the Run |
| [1519](../../test/v2-run-issue.test.ts#L1519) | good | issue-comment completed repair starts fresh proof even without configured checks |
| [1535](../../test/v2-run-issue.test.ts#L1535) | good | review-feedback worktree drift durably opens targeted repair with fresh candidate proof |
| [1572](../../test/v2-run-issue.test.ts#L1572) | good | review-feedback drift persists repair before old pin cleanup failure and restart removes the orphan |
| [1614](../../test/v2-run-issue.test.ts#L1614) | good | review transport recovery preserves exact passed proof receipt and recovery context |
| [1629](../../test/v2-run-issue.test.ts#L1629) | good | trusted issue-comment repair runs checks, proof, review, and updates the same PR without replacement |
| [1866](../../test/v2-run-issue.test.ts#L1866) | good | review update revalidation settles the exact publication effect before mapping authority failure |
| [1876](../../test/v2-run-issue.test.ts#L1876) | good | ${stage.name} ${authorityStatus} |
| [1915](../../test/v2-run-issue.test.ts#L1915) | good | unknown review-summary observation retains the exact durable intent |
| [1931](../../test/v2-run-issue.test.ts#L1931) | good | deferred check and proof prevent every later publication effect and terminal return |
| [1952](../../test/v2-run-issue.test.ts#L1952) | good | four trusted post-PR feedback batches update the same Run and PR through fresh reviewed proof |
| [2064](../../test/v2-run-issue.test.ts#L2064) | rewrite | trusted feedback preserves exact Implement, Proof, and rejected Review blockers across outcome-evidence replay |
| [2178](../../test/v2-run-issue.test.ts#L2178) | good | not eligible and revoked authorization start no implementation or publication |
| [2193](../../test/v2-run-issue.test.ts#L2193) | good | malformed config stops while state I/O remains resumable before claim effects |
| [2203](../../test/v2-run-issue.test.ts#L2203) | good | unsupported state is effect-free before owner lock and after authoritative reread |
| [2226](../../test/v2-run-issue.test.ts#L2226) | good | unsupported-state diagnostics reach the public result without claiming the repository |
| [2234](../../test/v2-run-issue.test.ts#L2234) | good | real old, unknown, malformed, and missing-discriminator state bytes remain unchanged and effect-free |
| [2254](../../test/v2-run-issue.test.ts#L2254) | good | a state identity that changes twice after owner lock requeues without effects |
| [2272](../../test/v2-run-issue.test.ts#L2272) | good | claimed initialization verifies the pinned workflow generation before implementation |
| [2281](../../test/v2-run-issue.test.ts#L2281) | good | worktree creation failure is diagnostic and resumes the claimed run |
| [2302](../../test/v2-run-issue.test.ts#L2302) | good | base refresh failure is resumable and creates no claim or run state |
| [2312](../../test/v2-run-issue.test.ts#L2312) | good | a discovered base mismatch creates no claim, implementation worktree, or run state |
| [2322](../../test/v2-run-issue.test.ts#L2322) | good | an existing run retains its pinned base and rejects a different discovery base without changing state |
| [2342](../../test/v2-run-issue.test.ts#L2342) | good | partial worktree creation artifacts remain correctable in the same claimed run |
| [2358](../../test/v2-run-issue.test.ts#L2358) | good | diverged claimed worktree remains correctable instead of becoming terminal |
| [2373](../../test/v2-run-issue.test.ts#L2373) | good | historical claim markers do not revoke a newly claimed run |
| [2388](../../test/v2-run-issue.test.ts#L2388) | good | a pre-upgrade snapshot without comment ids accepts only a live claim that predates the run |
| [2425](../../test/v2-run-issue.test.ts#L2425) | good | agent-authored commit and proof external block map without publication |
| [2446](../../test/v2-run-issue.test.ts#L2446) | good | ignored repository-relative denied path mutation blocks publication |
| [2456](../../test/v2-run-issue.test.ts#L2456) | good | new candidate starts fresh proof recovery while unchanged candidate resumes exact facts |
| [2503](../../test/v2-run-issue.test.ts#L2503) | good | failed checks and proof findings rework the same worktree until review-ready |
| [2530](../../test/v2-run-issue.test.ts#L2530) | good | configured check outputs cannot contaminate the next check or published source |
| [2546](../../test/v2-run-issue.test.ts#L2546) | good | configured check outputs do not mask a failing check or block its repair |
| [2562](../../test/v2-run-issue.test.ts#L2562) | good | configured checks still reject edited, deleted, staged and committed source changes |
| [2580](../../test/v2-run-issue.test.ts#L2580) | good | configured check output isolation survives restart after result adoption |
| [2612](../../test/v2-run-issue.test.ts#L2612) | good | configured check outputs survive receipt recovery without rerunning the check |
| [2638](../../test/v2-run-issue.test.ts#L2638) | good | a check without a saved result discards its outputs before a fresh execution |
| [2661](../../test/v2-run-issue.test.ts#L2661) | good | a missing check result cannot hide changed pinned source on restart |
| [2678](../../test/v2-run-issue.test.ts#L2678) | good | cancelled check outputs cannot turn the retained cancellation into source mutation |
| [2698](../../test/v2-run-issue.test.ts#L2698) | good | untracked source additions by a reviewer still block publication |
| [2710](../../test/v2-run-issue.test.ts#L2710) | good | configured checks receive the complete immutable candidate file set |
| [2722](../../test/v2-run-issue.test.ts#L2722) | good | repeated failed check on unchanged candidate stops instead of cycling or accepting it |
| [2748](../../test/v2-run-issue.test.ts#L2748) | good | successful check clears its failure marker before a later unchanged-code repair |
| [2772](../../test/v2-run-issue.test.ts#L2772) | good | retained successful check clears a stale failure marker on reentry |
| [2799](../../test/v2-run-issue.test.ts#L2799) | good | accepted target clears a prior failure for a removed check |
| [2814](../../test/v2-run-issue.test.ts#L2814) | good | same failed check permits another repair when candidate code changes |
| [2830](../../test/v2-run-issue.test.ts#L2830) | good | a different check identity or command permits repair on unchanged code |
| [2849](../../test/v2-run-issue.test.ts#L2849) | good | sixth in-scope repair continues the same Run without semantic exhaustion |
| [2867](../../test/v2-run-issue.test.ts#L2867) | good | review blockers form one targeted repair batch bound to fresh affected proof |
| [2904](../../test/v2-run-issue.test.ts#L2904) | good | answer-only outside issue feedback retries the report instead of terminating review repair |
| [2949](../../test/v2-run-issue.test.ts#L2949) | good | check and proof blockers join the active review repair batch with exact source impact |
| [2978](../../test/v2-run-issue.test.ts#L2978) | good | repair review remains targeted while checks and criteria conservatively use full coverage |
| [2993](../../test/v2-run-issue.test.ts#L2993) | good | targeted out-of-cone finding reruns full proof and complete Review for the same target |
| [3028](../../test/v2-run-issue.test.ts#L3028) | good | one in-cone target cannot hide another out-of-cone target from complete fallback |
| [3045](../../test/v2-run-issue.test.ts#L3045) | good | approved targeted Review with an open out-of-cone improvement expands to complete validation |
| [3066](../../test/v2-run-issue.test.ts#L3066) | good | review waits when no exact complete or targeted tree delta can be supplied |
| [3074](../../test/v2-run-issue.test.ts#L3074) | good | Review accepts explicit dummy session tokens and proceeds through checks |
| [3083](../../test/v2-run-issue.test.ts#L3083) | rewrite | credential-bearing Review target blocks durably instead of retrying transport |
| [3101](../../test/v2-run-issue.test.ts#L3101) | good | Review admits a large exact target and waits for denied paths |
| [3116](../../test/v2-run-issue.test.ts#L3116) | good | blocked comments explain the exact stop and retain implementation context |
| [3131](../../test/v2-run-issue.test.ts#L3131) | good | a missing candidate adapter before implementation does not invent retained work |
| [3142](../../test/v2-run-issue.test.ts#L3142) | good | ordinary external and safety terminals publish the blocked issue status |
| [3161](../../test/v2-run-issue.test.ts#L3161) | good | issue-local authority blockers preserve their exact evidence-bearing public shape |
| [3184](../../test/v2-run-issue.test.ts#L3184) | good | authority blocker outcome evidence replays exact detail after the terminal state write fails |
| [3216](../../test/v2-run-issue.test.ts#L3216) | good | temporary proof service unavailability resumes the same Run without duplicate implementation or publication |
| [3242](../../test/v2-run-issue.test.ts#L3242) | good | mobile cleanup failure retains the proof materialization and resumes cleanup before Review |
| [3265](../../test/v2-run-issue.test.ts#L3265) | good | pre-launch mobile preparation blocker survives cleanup retry without launching proof or publication |
| [3279](../../test/v2-run-issue.test.ts#L3279) | good | restart after cleanup outcome adoption removes materialization and continues Review without rerunning proof |
| [3310](../../test/v2-run-issue.test.ts#L3310) | good | revoked issue authority still releases retained mobile resources before terminal state |
| [3325](../../test/v2-run-issue.test.ts#L3325) | good | blocked label delivery resumes from its durable pendingEffect without rerunning work |
| [3349](../../test/v2-run-issue.test.ts#L3349) | good | blocked terminal publishes its reason before labels and does not duplicate the comment on replay |
| [3379](../../test/v2-run-issue.test.ts#L3379) | good | blocked terminal publishes bounded public text without host paths or credential evidence |
| [3395](../../test/v2-run-issue.test.ts#L3395) | good | host identity detection covers generic and Markdown-delimited paths without rejecting artifact text |
| [3416](../../test/v2-run-issue.test.ts#L3416) | good | dummy token exception is exact and does not suppress other credential evidence |
| [3440](../../test/v2-run-issue.test.ts#L3440) | good | credential detection covers public terminal credential forms |
| [3451](../../test/v2-run-issue.test.ts#L3451) | good | blocked comment settlement never posts after the issue closes |
| [3476](../../test/v2-run-issue.test.ts#L3476) | good | blocked comment delivery resumes from its durable intent without rerunning work |
| [3497](../../test/v2-run-issue.test.ts#L3497) | good | blocked comment survives a crash after remote publication without duplication or rerunning work |
| [3522](../../test/v2-run-issue.test.ts#L3522) | good | closed issue confirms a previously posted terminal comment without another publication |
| [3542](../../test/v2-run-issue.test.ts#L3542) | good | blocked label delivery survives a crash after the remote effect without duplicating work or labels |
| [3560](../../test/v2-run-issue.test.ts#L3560) | good | blocked terminal replay repairs a stale running label without rerunning work |
| [3584](../../test/v2-run-issue.test.ts#L3584) | good | blocked transition preserves concurrent labels and never restores revoked authorization |
| [3599](../../test/v2-run-issue.test.ts#L3599) | good | blocked transition resumes when the post-effect projection write fails |
| [3618](../../test/v2-run-issue.test.ts#L3618) | good | malformed report and clean transport failures retry full implementation without consuming a cycle |
| [3642](../../test/v2-run-issue.test.ts#L3642) | good | incomplete cumulative changedFiles retries full implementation without consuming a cycle |
| [3656](../../test/v2-run-issue.test.ts#L3656) | good | six malformed implementation reports retry full implementation for one product result |
| [3680](../../test/v2-run-issue.test.ts#L3680) | good | proof ${failure.kind} evidence preserves its cause and retries only proof on the same checked candidate |
| [3704](../../test/v2-run-issue.test.ts#L3704) | good | proof report correction preserves its exact result and artifacts through ${fault} |
| [3761](../../test/v2-run-issue.test.ts#L3761) | good | ordinary proof terminal retry requires proven technical evidence and preserves successful checks |
| [3780](../../test/v2-run-issue.test.ts#L3780) | good | legacy explicit technical terminal resumes the same checked candidate without reimplementation |
| [3800](../../test/v2-run-issue.test.ts#L3800) | good | settled implementation, proof, and review infrastructure failures resume on the next bounded run |
| [3836](../../test/v2-run-issue.test.ts#L3836) | good | resumable implementation transport retries once when the interrupted attempt changed the worktree |
| [3853](../../test/v2-run-issue.test.ts#L3853) | good | restart cannot continue ${phase} with a retained subset of mandatory checks |
| [3880](../../test/v2-run-issue.test.ts#L3880) | good | publication tree observation failure preserves the exact intent and resumes without implementation |
| [3897](../../test/v2-run-issue.test.ts#L3897) | good | invoked publication rejection is resumable, retains pendingEffect, and starts no later effect |
| [3907](../../test/v2-run-issue.test.ts#L3907) | good | every invoked effect rejection stays resumable with its exact durable pendingEffect |
| [3954](../../test/v2-run-issue.test.ts#L3954) | good | unknown candidate branch CAS observes an exact completed effect before replay |
| [3965](../../test/v2-run-issue.test.ts#L3965) | good | confirmed candidate commit retains identity until fallible cleanup is reconciled |
| [3982](../../test/v2-run-issue.test.ts#L3982) | good | a rejected claim comment never grants the running status label |
| [3993](../../test/v2-run-issue.test.ts#L3993) | good | implementation and proof transport, cancellation, internal failure, and malformed reports stay typed |
| [4015](../../test/v2-run-issue.test.ts#L4015) | good | candidate proof inspection failures retain typed recovery and evidence states |
| [4056](../../test/v2-run-issue.test.ts#L4056) | good | post-proof candidate drift opens the next bounded cycle without a terminal wedge |
| [4071](../../test/v2-run-issue.test.ts#L4071) | good | post-proof drift persists the next cycle before fallible pin cleanup |
| [4086](../../test/v2-run-issue.test.ts#L4086) | good | issue read rejection and post-effect CAS failure are resumable with retained pendingEffect |
| [4100](../../test/v2-run-issue.test.ts#L4100) | good | restart after effect-before-confirmation reconciles publication without duplicate effects |
| [4130](../../test/v2-run-issue.test.ts#L4130) | good | restart reconciles an interrupted claim without creating a second run |
| [4144](../../test/v2-run-issue.test.ts#L4144) | good | restart resumes interrupted implementation in the same worktree as the next bounded cycle |
| [4173](../../test/v2-run-issue.test.ts#L4173) | good | safe-halt returns after one tick, preserves attempt identity, and retries without semantic spend |
| [4209](../../test/v2-run-issue.test.ts#L4209) | good | one bounded safe-halt observation covers every live operation family without replacement or budget spend |
| [4256](../../test/v2-run-issue.test.ts#L4256) | good | safe-halt observation failure is bounded and exact result adoption prevents replacement |
| [4311](../../test/v2-run-issue.test.ts#L4311) | good | cancellation waits for deferred check and proof settlement before terminal state and owner release |
| [4335](../../test/v2-run-issue.test.ts#L4335) | good | cancellation also waits for an in-flight store write and remote effect before releasing ownership |
| [5288](../../test/v2-run-issue.test.ts#L5288) | good | failed configured check retains the candidate and prevents proof, Review and publication |
| [5305](../../test/v2-run-issue.test.ts#L5305) | good | host Flutter environment recovery does not repeat implementation |
| [5321](../../test/v2-run-issue.test.ts#L5321) | good | restart after the second mandatory check becomes unavailable reuses the first receipt without repeating implementation |
| [5356](../../test/v2-run-issue.test.ts#L5356) | good | a genuinely missing configured executable resumes on the same candidate after restoration (interrupted result adoption: ${interrupted}) |

### test/v2-run-store.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [20](../../test/v2-run-store.test.ts#L20) | good | run state performs absent-state CAS and rejects stale or concurrent writers |
| [42](../../test/v2-run-store.test.ts#L42) | good | run state inspection reports absent without creating storage |
| [56](../../test/v2-run-store.test.ts#L56) | good | run state inspection reports supported exact-schema state with its raw SHA |
| [78](../../test/v2-run-store.test.ts#L78) | good | legacy envelopes preserve current records and normalize only on the next CAS |
| [94](../../test/v2-run-store.test.ts#L94) | good | run state inspection reports malformed and unknown schemas as unsupported without effects |
| [118](../../test/v2-run-store.test.ts#L118) | good | legacy compatibility never accepts future versions, removed execution fields, or missing authority |
| [138](../../test/v2-run-store.test.ts#L138) | good | incompatible legacy records explain the blocker without leaking their contents |
| [150](../../test/v2-run-store.test.ts#L150) | good | run state rejects malformed and lifecycle-inconsistent records |
| [166](../../test/v2-run-store.test.ts#L166) | good | run state accepts unbounded semantic revisions and resumable infrastructure recovery counters |
| [196](../../test/v2-run-store.test.ts#L196) | good | failed check repair identity is optional, durable, and strictly validated |
| [220](../../test/v2-run-store.test.ts#L220) | good | run state rejects retired legacy blocked terminal effects |
| [234](../../test/v2-run-store.test.ts#L234) | good | run state round-trips bounded terminal notification diagnostics and cutoff |
| [269](../../test/v2-run-store.test.ts#L269) | good | run state binds terminal notifications and pending delivery effects to the terminal outcome |
| [313](../../test/v2-run-store.test.ts#L313) | good | pre-rename faults preserve prior generation and post-rename faults reconcile exact committed bytes |
| [332](../../test/v2-run-store.test.ts#L332) | good | ambiguous post-rename third state fails closed without overwrite |
| [346](../../test/v2-run-store.test.ts#L346) | good | file lock blocks stale, foreign, malformed, and live owners without reclaiming |
| [363](../../test/v2-run-store.test.ts#L363) | good | lock release is token-safe |
| [380](../../test/v2-run-store.test.ts#L380) | good | state publication rejects symlinked parent directories before writing outside |
| [490](../../test/v2-run-store.test.ts#L490) | good | per-issue journals preserve more than 256 issues without cumulative file limits |
| [506](../../test/v2-run-store.test.ts#L506) | good | large run histories are lossless hashed evidence and stay bounded per state file |
| [524](../../test/v2-run-store.test.ts#L524) | keep-temporarily | migration resumes after a killed writer and preserves the original journal |
| [568](../../test/v2-run-store.test.ts#L568) | good | migration divergence preserves both destination and original bytes |
| [580](../../test/v2-run-store.test.ts#L580) | good | large legacy migration archives each Run and missing migrated state blocks replacement |
| [598](../../test/v2-run-store.test.ts#L598) | good | foreign-repository legacy migration is blocked before any destination mutation |

### test/v2-runtime-assets.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [29](../../test/v2-runtime-assets.test.ts#L29) | good | implementer profile treats listed files as starting points for the authorized outcome |
| [35](../../test/v2-runtime-assets.test.ts#L35) | good | production proof freshness requires the entire current configured check authority |
| [48](../../test/v2-runtime-assets.test.ts#L48) | good | report read view excludes env, denied paths, and symlinks before contained report launch |
| [79](../../test/v2-runtime-assets.test.ts#L79) | good | report read view rejects a destination inside the source worktree before mutation |
| [104](../../test/v2-runtime-assets.test.ts#L104) | good | operation snapshot copies one pinned generation closure and concurrent publishers reuse it |
| [137](../../test/v2-runtime-assets.test.ts#L137) | good | implementation snapshot carries the bug workflow documents |
| [161](../../test/v2-runtime-assets.test.ts#L161) | good | operation snapshots resolve contained references and complete referenced skill closures |
| [202](../../test/v2-runtime-assets.test.ts#L202) | good | contained Android proof receives only Runner-prepared evidence and no host mutation authority |
| [306](../../test/v2-runtime-assets.test.ts#L306) | good | contained implementation and proof map a settled launch-gate failure to resumable infrastructure |
| [413](../../test/v2-runtime-assets.test.ts#L413) | good | operation snapshot fails closed on tamper, path escape, and undeclared operation |
| [438](../../test/v2-runtime-assets.test.ts#L438) | good | operation snapshot rejects self-consistent closures missing derived skills or documents |
| [455](../../test/v2-runtime-assets.test.ts#L455) | good | runtime verifier rejects removal of Markdown, inline, and workflow-root references |
| [485](../../test/v2-runtime-assets.test.ts#L485) | good | runtime verifier applies every skill binding form and ignores fenced examples |
| [493](../../test/v2-runtime-assets.test.ts#L493) | good | form-${index + 1} |
| [517](../../test/v2-runtime-assets.test.ts#L517) | good | operation snapshot rejects self-consistent removal of referenced bug workflow documents |
| [554](../../test/v2-runtime-assets.test.ts#L554) | good | operation snapshot rejects a runtime root below a symlinked ancestor |
| [575](../../test/v2-runtime-assets.test.ts#L575) | good | operation snapshot converges after publisher process death at every ready boundary |
| [714](../../test/v2-runtime-assets.test.ts#L714) | good | implementation and proof format correction use exact bytes/schema in read-only view without semantic instructions |

### test/v2-runtime-codex.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [12](../../test/v2-runtime-codex.test.ts#L12) | good | runtime resolves the installed Codex executable only from its safe path |
| [35](../../test/v2-runtime-codex.test.ts#L35) | good | runtime cleanup removes only the exact canonical attempt read-view |
| [52](../../test/v2-runtime-codex.test.ts#L52) | good | runtime cleanup rejects forged and symlink-redirected attempt roots without deletion |
| [79](../../test/v2-runtime-codex.test.ts#L79) | good | production issue composition mutates only lifecycle-managed labels |
| [101](../../test/v2-runtime-codex.test.ts#L101) | good | Runner review files retain exact large facts and reject altered hashes and path escapes |
| [113](../../test/v2-runtime-codex.test.ts#L113) | good | legacy proof recovery admits only bound host evidence proving a technical failure |
| [146](../../test/v2-runtime-codex.test.ts#L146) | good | runtime reads complete comments on closed issues to observe already published effects |
| [166](../../test/v2-runtime-codex.test.ts#L166) | good | runtime fences command ownership before launch and retains unconfirmed cleanup |

### test/v2-self-recovery-restart.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [66](../../test/v2-self-recovery-restart.test.ts#L66) | good | a real killed Runner resumes ${checkpoint} with durable identity and no duplicate successful work |
| [110](../../test/v2-self-recovery-restart.test.ts#L110) | good | a real killed Runner observes ${checkpoint} without redelivering or reopening its blocked outcome |
| [153](../../test/v2-self-recovery-restart.test.ts#L153) | good | a real killed Runner resumes ${scenario.checkpoint} with revoked auto=${scenario.revoke}, closed=${scenario.close} and one durable answer |
| [208](../../test/v2-self-recovery-restart.test.ts#L208) | good | a real killed Runner resumes ${checkpoint} by correcting the exact report over retained proof evidence |

### test/v2-setup-cli.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [7](../../test/v2-setup-cli.test.ts#L7) | good | setup parser maps only operational intent and rejects ambiguous flags |
| [27](../../test/v2-setup-cli.test.ts#L27) | good | setup JSON and exit mapping are total over typed outcomes |

### test/v2-setup-runtime.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [14](../../test/v2-setup-runtime.test.ts#L14) | good | production Setup composition always derives the base branch from origin/HEAD |

### test/v2-setup.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [11](../../test/v2-setup.test.ts#L11) | good | Setup.execute creates minimal config last and repeat configure is byte-stable |
| [40](../../test/v2-setup.test.ts#L40) | good | Setup.execute dry-run returns exact ordered actions and performs zero writes |
| [57](../../test/v2-setup.test.ts#L57) | good | Setup.execute rejects repository mismatch before local writes |
| [72](../../test/v2-setup.test.ts#L72) | good | Setup.execute refuses a symlinked managed directory without writing outside target |
| [82](../../test/v2-setup.test.ts#L82) | good | prepare-labels paginates case-insensitively and creates only missing labels after config commit |
| [103](../../test/v2-setup.test.ts#L103) | good | prepare-labels dry-run reports local and paginated GitHub actions with zero writes |
| [123](../../test/v2-setup.test.ts#L123) | good | prepare-labels returns typed partial progress and always releases ownership |
| [140](../../test/v2-setup.test.ts#L140) | good | prepare-labels reconciles already-exists only after a complete reread observes it |
| [150](../../test/v2-setup.test.ts#L150) | good | doctor and status return deterministic read-only diagnostics owned by Setup |
| [174](../../test/v2-setup.test.ts#L174) | good | configure converges after every injected config publication boundary |
| [176](../../test/v2-setup.test.ts#L176) | good | point |

### test/v2-validation-progression.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [16](../../test/v2-validation-progression.test.ts#L16) | good | issue authority dispatches implementation then checks proof review and publication |
| [38](../../test/v2-validation-progression.test.ts#L38) | good | post-PR feedback changes context but not validation progression ownership |
| [59](../../test/v2-validation-progression.test.ts#L59) | good | validation progression rejects mismatched authority, pending effects, and non-validation phases |
| [73](../../test/v2-validation-progression.test.ts#L73) | good | semantic repair returns one CAS transition without a reworking lifecycle |
| [97](../../test/v2-validation-progression.test.ts#L97) | good | semantic repair revisions are unbounded and remain Run-owned |
| [105](../../test/v2-validation-progression.test.ts#L105) | good | CAS consumption rejects stale authority context before any write |
| [121](../../test/v2-validation-progression.test.ts#L121) | good | production transition adapter rejects every stale expected field before RunRecordWriter CAS |

### test/v2-workflow-assets.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [18](../../test/v2-workflow-assets.test.ts#L18) | good | workflow reference extraction recognizes supported forms and rejects root escape |
| [48](../../test/v2-workflow-assets.test.ts#L48) | good | workflow generation materializes one immutable concurrent winner and survives package source mutation |
| [72](../../test/v2-workflow-assets.test.ts#L72) | good | workflow V2 binds the minimal coding flow and keeps static scenarios out of attempt closures |
| [99](../../test/v2-workflow-assets.test.ts#L99) | good | workflow loader accepts all skill and resource binding reference forms |
| [125](../../test/v2-workflow-assets.test.ts#L125) | good | workflow packages only static target scenarios with no live execution metadata |
| [155](../../test/v2-workflow-assets.test.ts#L155) | good | workflow loader and generation verifier fail closed on tamper and invalid ready receipts |
| [166](../../test/v2-workflow-assets.test.ts#L166) | good | workflow loader rejects a canonically rehashed manifest that widens operation authority |
| [181](../../test/v2-workflow-assets.test.ts#L181) | good | workflow loader rejects canonically rehashed V2 bytes whose adapter omits a declared dependency |
| [199](../../test/v2-workflow-assets.test.ts#L199) | good | workflow loader rejects canonically rehashed production closures missing bug workflow documents |
| [230](../../test/v2-workflow-assets.test.ts#L230) | good | workflow loader accepts workflow-owned profiles and rejects non-canonical manifest bytes |
| [252](../../test/v2-workflow-assets.test.ts#L252) | good | workflow generation converges after publisher process death at every ready boundary |
| [276](../../test/v2-workflow-assets.test.ts#L276) | good | workflow ready reuse validates its claim chain and an in-process sealed failure can retry |
| [296](../../test/v2-workflow-assets.test.ts#L296) | good | workflow loader and publisher reject symlinked authority roots |

### test/v2-workflow-import.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [18](../../test/v2-workflow-import.test.ts#L18) | good | workflow sync is byte and mode stable and check rejects stale generated bytes |
| [86](../../test/v2-workflow-import.test.ts#L86) | good | manifest binds the declared transitive closure |
| [103](../../test/v2-workflow-import.test.ts#L103) | good | workflow source v2 derives transitive skill and referenced document closure for operations |
| [290](../../test/v2-workflow-import.test.ts#L290) | good | workflow sync accepts every skill binding reference form in skills and operations |
| [354](../../test/v2-workflow-import.test.ts#L354) | good | form.id |
| [374](../../test/v2-workflow-import.test.ts#L374) | good | fenced-only skill mention survives sync and verify without becoming a consumer dependency |
| [402](../../test/v2-workflow-import.test.ts#L402) | good | workflow sync rejects config replacement after the initial authority read |

### test/v2-worktree-recovery.test.ts

| Строка | Категория | Case |
| ---: | --- | --- |
| [15](../../test/v2-worktree-recovery.test.ts#L15) | good | a merged branch collision preserves a materialization whose run ownership is unknown |
| [29](../../test/v2-worktree-recovery.test.ts#L29) | good | worktree inspection returns after an owned Git command hangs |

### test/fixtures/v2-mobile-fixture/test/widget_test.dart

| Строка | Категория | Case |
| ---: | --- | --- |
| [5](../../test/fixtures/v2-mobile-fixture/test/widget_test.dart#L5) | good | fixture reaches the final Android proof state |

### test/fixtures/v2-mobile-fixture/configure_ios_ui_test.rb

| Строка | Категория | Case |
| ---: | --- | --- |
| [16](../../test/fixtures/v2-mobile-fixture/configure_ios_ui_test.rb#L16) | good | testProofWorkflow (generated XCTest) |

## Порядок безопасной правки и приёмка

1. Исправлять blind assertions узкими группами в существующих tests. Сначала добиться содержательного RED: удаление/нарушение нужного guard должно ломать конкретный test по нужной причине, а unrelated earlier failure не должно делать negative case зелёным.
2. Для negative fixtures сначала подтвердить, что немутированный control проходит; затем менять одно поле и проверять точную причину отказа. Это особенно важно для duplicate IDs, proof level, expiry/unbound.
3. Для races заменить sleep на явные bounded barriers; после проверки fault cleanup обязателен даже при assertion failure. Не прекращать чужие процессы/сессии.
4. Для smoke-script переиспользовать существующие self-test modes или минимальный import-safe seam; проверять локальные refs/worktrees/argv/reports и отсутствие effects. Тексты help/prompts и manifest/schema оставить статическими контрактами.
5. После каждой группы запустить затронутые compiled Node tests; после всех правок — общий `npm test`. Этот отчёт фиксирует аудит, а не реализацию исправлений.
