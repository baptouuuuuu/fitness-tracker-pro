import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

test('activation vérifiée et restauration de la version précédente', t => {
  const home = mkdtempSync(join(tmpdir(), 'fitness-deploy-'));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  const root = join(home, 'fitness-tracker');
  const release = `${'a'.repeat(40)}-1-1`;
  const next = join(root, 'releases', release);
  const previous = join(root, 'releases', 'previous');
  const bin = join(home, 'bin');
  mkdirSync(next, {recursive:true});
  mkdirSync(previous, {recursive:true});
  mkdirSync(bin);
  mkdirSync(join(home, '.config'));
  writeFileSync(join(next, 'server.js'), '');
  writeFileSync(join(home, '.config', 'fitness-tracker.env'), '');
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
echo "$*" >> "$TEST_LOG"
if [ "$2" = restart ] && [ -f "$TEST_FAIL" ]; then rm "$TEST_FAIL"; exit 1; fi
`, {mode:0o755});
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
if [ -f "$TEST_HEALTH_FAIL" ] && [ "$(readlink "$HOME/fitness-tracker/current")" = "$TEST_NEW" ]; then exit 1; fi
`, {mode:0o755});
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', {mode:0o755});
  symlinkSync(previous, join(root, 'current'));
  const env = {...process.env, HOME:home, PATH:`${bin}:${process.env.PATH}`, TEST_LOG:join(home, 'log'), TEST_FAIL:join(home, 'fail'), TEST_HEALTH_FAIL:join(home, 'health-fail'), TEST_NEW:next};
  const activate = () => spawnSync('bash', ['deploy/activate.sh', release], {env, encoding:'utf8'});
  writeFileSync(env.TEST_FAIL, '');
  assert.notEqual(activate().status, 0);
  assert.equal(readlinkSync(join(root, 'current')), previous);
  assert.equal(readFileSync(env.TEST_LOG, 'utf8').trim().split('\n').filter(line => line.includes('restart')).length, 2);
  writeFileSync(env.TEST_HEALTH_FAIL, '');
  assert.notEqual(activate().status, 0);
  assert.equal(readlinkSync(join(root, 'current')), previous);
  rmSync(env.TEST_HEALTH_FAIL);
  assert.equal(activate().status, 0);
  assert.equal(readlinkSync(join(root, 'current')), next);
});

test('une version invalide ne modifie pas le déploiement', () => {
  const result = spawnSync('bash', ['deploy/activate.sh', '../bad'], {encoding:'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalide/);
});

test('le serveur démarre depuis le lien current de systemd', async t => {
  const home = mkdtempSync(join(tmpdir(), 'fitness-symlink-'));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  symlinkSync(process.cwd(), join(home, 'current'));
  const child = spawn(process.execPath, [join(home, 'current', 'server.js')], {
    env:{...process.env, HOST:'127.0.0.1', PORT:'0', DATABASE_PATH:':memory:', APP_URL:'http://localhost:3000'},
    stdio:['ignore', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Le serveur ne démarre pas.')), 5000);
    child.stdout.once('data', data => { clearTimeout(timer); resolve(String(data)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Le serveur a quitté (${code}).`)); });
  });
  assert.match(result, /Fitness Tracker écoute/);
});
