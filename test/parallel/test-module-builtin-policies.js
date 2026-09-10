// Flags: --expose-internals
'use strict';

// Run before loading common, whose async-hooks checks need --expose-internals.
// Child processes and Workers exercise only the public loaders.
if (process.argv[2] === 'child') {
  const policy = JSON.parse(process.argv[3]);
  const enabled = process.argv[4] === 'true';
  checkPolicy(policy, enabled).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
  return;
}

const common = require('../common');
const assert = require('assert');
const { isBuiltin } = require('module');
const { Worker } = require('worker_threads');
const { spawnSyncAndAssert } = require('../common/child_process');
const {
  internalBinding,
  getBuiltinModulePolicies,
} = require('internal/test/binding');
const { getCLIOptionsInfo, getOptionValue } = require('internal/options');

const policies = getBuiltinModulePolicies();
const {
  builtinIds,
  builtinCategories: { canBeRequired, cannotBeRequired },
} = internalBinding('builtins');
const { options } = getCLIOptionsInfo();
const seenIds = new Set();
const moduleAvailability = new Map([
  ['dtls', common.hasDtls],
  ['ffi', common.hasFFI],
  ['quic', common.hasQuic],
  ['sqlite', common.hasSQLite],
]);

for (const policy of policies) {
  assert.deepStrictEqual(Object.keys(policy).sort(), ['id', 'option', 'schemeOnly']);
  const { id, schemeOnly, option } = policy;
  assert.strictEqual(typeof id, 'string');
  assert(!id.startsWith('internal/'), id);
  assert(builtinIds.includes(id), `Unknown builtin: ${id}`);
  assert(!seenIds.has(id), `Duplicate policy: ${id}`);
  seenIds.add(id);
  assert.strictEqual(typeof schemeOnly, 'boolean', id);

  if (option !== null) {
    // Code-cache tests exclude modules that need runtime options.
    assert(cannotBeRequired.has(id), id);
    assert(!canBeRequired.has(id), id);
    assert.match(option, /^--experimental-[a-z-]+$/);
    // FFI has no CLI option in builds without FFI support.
    const missingFFIOption = id === 'ffi' && !common.hasFFI &&
      option === '--experimental-ffi';
    assert(options.has(option) || missingFFIOption,
           `Unknown builtin option: ${option}`);
    if (moduleAvailability.get(id) !== false) {
      // DTLS and QUIC options are no-ops in builds without their support.
      assert.strictEqual(typeof getOptionValue(option), 'boolean', option);
    }
  }
}

// Callers must not be able to change the loader's policy through this API.
const copy = getBuiltinModulePolicies();
copy[0].id = 'changed';
copy.pop();
assert.deepStrictEqual(getBuiltinModulePolicies(), policies);

// Cover shared flags, both scheme rules, and an option enabled by default.
const workerPolicyIds = new Set([
  'bench', 'bench/reporters', 'stream/iter', 'zlib/iter', 'sqlite',
]);

for (const policy of policies) {
  const { id, option } = policy;
  if (moduleAvailability.get(id) === false) continue;

  runPolicyTest(policy, [], option === null || options.get(option).defaultIsTrue);
  if (option !== null) {
    const disabledOption = option.replace('--', '--no-');
    runPolicyTest(policy, [option], true);
    runPolicyTest(policy, [disabledOption], false);

    if (!process.config.variables.node_without_node_options) {
      runPolicyTest(policy, [], true, option);
      runPolicyTest(policy, [], false, disabledOption);
      // Command-line options take precedence over NODE_OPTIONS.
      runPolicyTest(policy, [option], true, disabledOption);
      runPolicyTest(policy, [disabledOption], false, option);
    }

    if (workerPolicyIds.has(id)) {
      const parentEnabled = isBuiltin(`node:${id}`);
      for (const enabled of [true, false]) {
        const worker = new Worker(__filename, {
          argv: ['child', JSON.stringify(policy), String(enabled)],
          execArgv: [enabled ? option : disabledOption],
          env: { ...process.env, NODE_OPTIONS: '' },
        });
        worker.on('exit', common.mustCall((code) => {
          assert.strictEqual(code, 0);
          assert.strictEqual(isBuiltin(`node:${id}`), parentEnabled, id);
        }));
      }
    }
  }
}

// Run in a fresh process so each case initializes the loader with its flags.
function runPolicyTest(policy, flags, enabled, nodeOptions = '') {
  spawnSyncAndAssert(process.execPath, [
    ...flags,
    __filename,
    'child',
    JSON.stringify(policy),
    String(enabled),
  ], { env: { ...process.env, NODE_OPTIONS: nodeOptions } }, { status: 0 });
}

async function checkPolicy({ id, schemeOnly }, enabled) {
  const assert = require('assert');
  const { builtinModules, isBuiltin } = require('module');
  const prefixed = `node:${id}`;
  assert.strictEqual(builtinModules.includes(id), enabled && !schemeOnly, id);
  assert.strictEqual(builtinModules.includes(prefixed),
                     enabled && schemeOnly, prefixed);

  for (const specifier of [id, prefixed]) {
    const supported = enabled && (!schemeOnly || specifier === prefixed);
    assert.strictEqual(isBuiltin(specifier), supported, specifier);
    if (supported) {
      const exports = require(specifier);
      assert.strictEqual(process.getBuiltinModule(specifier), exports);
      assert.strictEqual((await import(specifier)).default, exports);
    } else {
      assert.strictEqual(process.getBuiltinModule(specifier), undefined);
      assert.throws(() => require(specifier), {
        code: specifier === prefixed ?
          'ERR_UNKNOWN_BUILTIN_MODULE' : 'MODULE_NOT_FOUND',
      });
      await assert.rejects(import(specifier), {
        code: specifier === prefixed ?
          'ERR_UNKNOWN_BUILTIN_MODULE' : 'ERR_MODULE_NOT_FOUND',
      });
    }
  }
}
