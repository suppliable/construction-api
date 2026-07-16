#!/usr/bin/env node
'use strict';

/**
 * Add or update the `warehouse_schedule` Remote Config key for one environment.
 *
 *   node scripts/publish-warehouse-schedule.js <dev|qa|prod> [--apply]
 *
 * Dry-run by default — prints the diff and exits without publishing. Pass
 * --apply to actually publish.
 *
 * This is deliberately a single-key upsert rather than a template import: the
 * checked-in rc-*.json snapshots have drifted from what's live (qa has 22 keys
 * live vs 16 in rc-qa.json), so importing a whole file would silently clobber
 * keys other people added through the console. Every other parameter is passed
 * through untouched.
 *
 * The schedule value is read from rc-<env>.json when present so the repo stays
 * the source of truth for the default; prod has no snapshot file, so it falls
 * back to the same standard hours.
 */

const fs = require('fs');
const path = require('path');

const ENVS = { dev: '.env.local.dev', qa: '.env.local.qa', prod: '.env.local.prod' };

// Standard business hours — used when the env has no rc-<env>.json snapshot.
const DEFAULT_SCHEDULE = JSON.stringify({
  days: {
    mon: ['08:45', '19:30'], tue: ['08:45', '19:30'], wed: ['08:45', '19:30'],
    thu: ['08:45', '19:30'], fri: ['08:45', '19:30'], sat: ['08:45', '19:30'],
    sun: null,
  },
  holidays: [],
});

const DESCRIPTION =
  'Business hours (IST) + holidays. days: {mon..sun: [open,close] as HH:MM, or null for closed all day}. ' +
  'holidays: ["YYYY-MM-DD"]. Malformed values fall back to Mon-Sat 08:45-19:30. Backend caches this 5 min.';

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

const target = process.argv[2];
const apply = process.argv.includes('--apply');

if (!ENVS[target]) {
  fail(`usage: node scripts/publish-warehouse-schedule.js <dev|qa|prod> [--apply]`);
}

const repoRoot = path.resolve(__dirname, '..');
const envFile = path.join(repoRoot, ENVS[target]);
if (!fs.existsSync(envFile)) fail(`env file not found: ${envFile}`);

// firebaseAdmin reads ENV_FILE at require time, so this must be set first.
process.env.ENV_FILE = envFile;
process.chdir(repoRoot);

const admin = require('../src/utils/firebaseAdmin');
const env = require('../src/config/env');
const { parseSchedule } = require('../src/utils/storeSchedule');

// Guard against the env-cascade footgun: refuse to touch the wrong project.
const EXPECTED_PROJECT = { dev: 'suppliable-dev', qa: 'suppliable-qa', prod: 'suppliable-app' };
if (!env.firebaseProjectId.includes(EXPECTED_PROJECT[target])) {
  fail(
    `refusing to publish: asked for "${target}" but credentials resolve to ` +
    `project "${env.firebaseProjectId}" (expected to contain "${EXPECTED_PROJECT[target]}")`
  );
}

function scheduleValue() {
  const snapshot = path.join(repoRoot, `rc-${target}.json`);
  if (fs.existsSync(snapshot)) {
    const params = JSON.parse(fs.readFileSync(snapshot, 'utf8')).parameters;
    if (params.warehouse_schedule) return params.warehouse_schedule.defaultValue.value;
  }
  return DEFAULT_SCHEDULE;
}

(async () => {
  const value = scheduleValue();

  // Never publish a value the backend would reject and silently fall back from.
  const parsed = parseSchedule(value);
  if (parsed.usedFallback) {
    fail(`the schedule value is malformed and would fall back at runtime:\n${value}`);
  }

  const rc = admin.remoteConfig();
  const template = await rc.getTemplate();
  const existing = template.parameters.warehouse_schedule;

  console.log(`Project:    ${env.firebaseProjectId} (${target})`);
  console.log(`Total keys: ${Object.keys(template.parameters).length}`);
  console.log(`Current:    ${existing ? existing.defaultValue.value : '(key does not exist)'}`);
  console.log(`New:        ${value}`);

  if (existing && existing.defaultValue.value === value) {
    console.log('\nNo change needed — already up to date.');
    return;
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to publish.');
    return;
  }

  template.parameters.warehouse_schedule = {
    defaultValue: { value },
    description: DESCRIPTION,
    valueType: 'STRING',
  };

  await rc.publishTemplate(template);

  const after = await rc.getTemplate();
  const published = after.parameters.warehouse_schedule;
  if (!published || published.defaultValue.value !== value) {
    fail('publish reported success but the value did not stick — check the console');
  }
  console.log(`\nPublished ✅  (${Object.keys(after.parameters).length} keys total, other keys untouched)`);
})().catch(err => fail(err.message));
