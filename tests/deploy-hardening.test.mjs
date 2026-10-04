import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) =>
  readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("production compose keeps background jobs independent from Telegram", () => {
  const compose = read("deploy/compose.yml");
  assert.match(compose, /background-worker:/);
  assert.match(compose, /scripts\/background-worker\.mts/);
  assert.match(compose, /telegram-worker:/);
  assert.match(compose, /scripts\/telegram-worker\.mts/);
  assert.match(compose, /meta-worker:/);
  const backgroundBlock = compose
    .split("  background-worker:", 2)[1]
    ?.split("\n  telegram-worker:", 1)[0] ?? "";
  assert.notEqual(backgroundBlock, "");
  assert.equal(/profiles:/.test(backgroundBlock), false);
});

test("database health and backup use runtime DB identity instead of brand names", () => {
  const compose = read("deploy/compose.yml");
  const backup = read("deploy/backup.sh");
  assert.match(compose, /\$\$POSTGRES_USER/);
  assert.match(compose, /\$\$POSTGRES_DB/);
  assert.match(backup, /POSTGRES_USER/);
  assert.match(backup, /POSTGRES_DB/);
  assert.equal(/pg_dump -U biznesoty -d biznesoty/.test(backup), false);
});

test("release is immutable and backs up before migrations", () => {
  const release = read("deploy/release.sh");
  assert.match(release, /sreda:\[a-f0-9\]\{40\}/);
  assert.equal(/biznesoty:latest/.test(release), false);
  const backupAt = release.indexOf("backup.sh");
  const migrateAt = release.indexOf("run --rm migrate");
  assert.ok(backupAt >= 0);
  assert.ok(migrateAt > backupAt);
  assert.match(release, /LAST_GOOD_IMAGE/);
  assert.match(release, /migration_before/);
  assert.match(release, /migration_after/);
});

test("controlled deployment does not require Yandex Registry credentials", () => {
  const workflow = read(".github/workflows/deploy-yandex.yml");
  const release = read("deploy/release.sh");
  assert.match(workflow, /IMAGE: biznesoty:\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /docker save "\$IMAGE"/);
  assert.match(workflow, /sha256sum -c biznesoty-image\.tar\.gz\.sha256/);
  assert.match(workflow, /docker load/);
  assert.equal(/YC_REGISTRY_KEY/.test(workflow), false);
  assert.equal(/docker\/login-action/.test(workflow), false);
  assert.match(release, /image_source="local"/);
  assert.match(release, /docker image inspect "\$image"/);
});

test("production image exposes immutable build metadata", () => {
  const dockerfile = read("Dockerfile");
  const workflow = read(".github/workflows/deploy-yandex.yml");
  const version = read("src/app/api/version/route.ts");
  assert.match(dockerfile, /APP_BUILD_SHA/);
  assert.match(workflow, /BUILD_SHA="\$GITHUB_SHA"/);
  assert.match(version, /APP_BUILD_SHA/);
  assert.match(version, /APP_BUILD_TIME/);
});

test("restore drill never targets production database", () => {
  const drill = read("deploy/restore-drill.sh");
  assert.match(drill, /docker run -d --rm/);
  assert.match(drill, /restore_test/);
  assert.match(drill, /pg_restore/);
  assert.equal(/deploy-db-1/.test(drill), false);
});

/**
 * SSH preflight перед передачей образа.
 *
 * Без него единственной проверкой связи был scp внутри шага доставки. Из-за
 * этого недоступный хост выглядел как «сбой деплоя» в шаге, который отвечает
 * ещё и за backup, миграции и health-check: два прогона (37182616336,
 * 37199303967) закончились одинаково — «Deliver immutable image and release —
 * exit 255» с `ssh: connect to host … port 22: Connection timed out`, и по
 * логу нельзя было отличить «сервер недоступен» от «деплой сломался».
 */
test("SSH preflight отсекает недоступный сервер до передачи образа", () => {
  const workflow = read(".github/workflows/deploy-yandex.yml");

  // Порядок шагов важен: preflight обязан идти после настройки ключей
  // (иначе нечем подключаться) и до доставки (иначе смысла нет).
  const configureIdx = workflow.indexOf("- name: Configure SSH");
  const preflightIdx = workflow.indexOf("- name: SSH preflight");
  const deliverIdx = workflow.indexOf("- name: Deliver immutable image and release");
  assert.ok(configureIdx > 0, "шаг Configure SSH должен существовать");
  assert.ok(preflightIdx > 0, "шаг SSH preflight должен существовать");
  assert.ok(deliverIdx > 0, "шаг доставки должен существовать");
  assert.ok(
    configureIdx < preflightIdx,
    "preflight обязан идти после Configure SSH — иначе ключ ещё не создан",
  );
  assert.ok(
    preflightIdx < deliverIdx,
    "preflight обязан идти ДО доставки — иначе он не выполнит свою задачу",
  );
});

test("preflight ограничен по времени и не полагается на таймаут по умолчанию", () => {
  const workflow = read(".github/workflows/deploy-yandex.yml");
  const preflight = workflow.slice(
    workflow.indexOf("- name: SSH preflight"),
    workflow.indexOf("- name: Deliver immutable image and release"),
  );

  // Шаг ограничен целиком: зависший ssh не должен занимать job до 40 минут.
  assert.match(preflight, /timeout-minutes:\s*\d+/);
  // ConnectTimeout ограничивает именно установку соединения — именно она
  // молчала при Connection timed out.
  assert.match(preflight, /-o ConnectTimeout=\d+/);
  assert.match(preflight, /-o ConnectionAttempts=1/);
});

test("preflight переиспользует те же секреты и настройки SSH, что и доставка", () => {
  const workflow = read(".github/workflows/deploy-yandex.yml");
  const preflight = workflow.slice(
    workflow.indexOf("- name: SSH preflight"),
    workflow.indexOf("- name: Deliver immutable image and release"),
  );

  assert.match(preflight, /HOST: \$\{\{ secrets\.DEPLOY_HOST \}\}/);
  assert.match(preflight, /LOGIN: \$\{\{ secrets\.DEPLOY_USER \}\}/);
  // Те же инварианты, что и в доставке: BatchMode запрещает интерактивный
  // пароль, StrictHostKeyChecking — accepting нового хоста без проверки.
  assert.match(preflight, /-o BatchMode=yes/);
  assert.match(preflight, /-o StrictHostKeyChecking=yes/);
  // -n не даёт пробросить stdin и заблокировать пробу.
  assert.match(preflight, /ssh -n/);
});

test("preflight не публикует секреты в лог", () => {
  const workflow = read(".github/workflows/deploy-yandex.yml");
  const preflight = workflow.slice(
    workflow.indexOf("- name: SSH preflight"),
    workflow.indexOf("- name: Deliver immutable image and release"),
  );

  // Ни ключ, ни хост, ни логин не печатаются: в лог идут только
  // обезличенные сообщения об ошибке.
  assert.equal(/echo\s+"?\$SSH_KEY/.test(preflight), false, "ключ не должен печататься");
  assert.equal(/echo\s+"?\$KNOWN_HOSTS/.test(preflight), false, "known_hosts не должен печататься");
  assert.equal(/echo\s+"?\$HOST/.test(preflight), false, "хост не должен печататься");
  assert.equal(/echo\s+"?\$LOGIN/.test(preflight), false, "логин не должен печататься");
  // set -x бы вывел все секреты в лог.
  assert.equal(/set -x/.test(preflight), false, "set -x раскрыл бы секреты в логах");
});

test("preflight проверяет наличие каталога доставки до передачи данных", () => {
  const workflow = read(".github/workflows/deploy-yandex.yml");
  const preflight = workflow.slice(
    workflow.indexOf("- name: SSH preflight"),
    workflow.indexOf("- name: Deliver immutable image and release"),
  );
  // Проба должна быть только чтением и не менять состояние сервера.
  assert.match(preflight, /test -d \/opt\/biznesoty\/deploy/);
  assert.equal(/docker|systemctl|bash \/|migrate|rm -|curl -X/i.test(preflight), false,
    "preflight не должен менять состояние сервера");
});

test("шаг доставки тоже ограничен по времени соединения", () => {
  const workflow = read(".github/workflows/deploy-yandex.yml");
  const deliver = workflow.slice(workflow.indexOf("- name: Deliver immutable image and release"));
  // Без ConnectTimeout зависшая сеть держала бы job до общего таймаута.
  assert.match(deliver, /scp[^\n]*-o ConnectTimeout=\d+/);
  assert.match(deliver, /ssh[^\n]*-o ConnectTimeout=\d+/);
});
