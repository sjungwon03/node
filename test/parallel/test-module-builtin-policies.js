// Flags: --expose-internals
'use strict';

const common = require('../common');
const assert = require('assert');
const { spawnSyncAndAssert } = require('../common/child_process');
const {
  internalBinding,
  getBuiltinModulePolicies,
} = require('internal/test/binding');
const { getCLIOptionsInfo, getOptionValue } = require('internal/options');

const policies = getBuiltinModulePolicies();
const { builtinIds } = internalBinding('builtins');
const { options } = getCLIOptionsInfo();
const seen = new Set();
const unavailable = new Set([
  ['dtls', common.hasDtls],
  ['ffi', common.hasFFI],
  ['quic', common.hasQuic],
  ['sqlite', common.hasSQLite],
].filter(([, available]) => !available).map(([id]) => id));

for (const policy of policies) {
  assert(Array.isArray(policy));
  assert.strictEqual(policy.length, 3);
  const [id, schemeOnly, option] = policy;
  assert.strictEqual(typeof id, 'string');
  assert(!id.startsWith('internal/'), id);
  assert(builtinIds.includes(id), `Unknown builtin: ${id}`);
  assert(!seen.has(id), `Duplicate policy: ${id}`);
  seen.add(id);
  assert.strictEqual(typeof schemeOnly, 'boolean', id);

  if (option !== null) {
    assert.match(option, /^--experimental-[a-z-]+$/);
    // FFI has no CLI option in builds without FFI support.
    const missingFFIOption = id === 'ffi' && !common.hasFFI &&
      option === '--experimental-ffi';
    assert(options.has(option) || missingFFIOption,
           `Unknown builtin option: ${option}`);
    if (!unavailable.has(id)) {
      // DTLS and QUIC options are no-ops in builds without their support.
      assert.strictEqual(typeof getOptionValue(option), 'boolean', option);
    }
  }
}

// Callers must not be able to change the loader's policy through this API.
const copy = getBuiltinModulePolicies();
copy[0][0] = 'changed';
copy.pop();
assert.deepStrictEqual(getBuiltinModulePolicies(), policies);

for (const policy of policies) {
  const [id, , option] = policy;
  if (unavailable.has(id)) continue;

  const cases = [[[], option === null || getOptionValue(option)]];
  if (option !== null) {
    cases.push([[option], true], [[option.replace('--', '--no-')], false]);
  }
  for (const [flags, enabled] of cases) {
    spawnSyncAndAssert(process.execPath, [
      ...flags,
      '-e', `
        (${checkPolicy})(${JSON.stringify(policy)}, ${enabled}).catch((err) => {
          console.error(err);
          process.exitCode = 1;
        });
      `,
    ], { status: 0 });
  }
}

// Run in a fresh process so each case initializes the loader with its flags.
async function checkPolicy([id, schemeOnly], enabled) {
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
