import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile, readFile, rm, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createProvider } from '../lib/provider.mjs';

test('loading the upgraded plugin preserves the account, existing headers and other providers',async () => {
  const parent=fileURLToPath(new URL('../.sandbox/',import.meta.url));
  await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent,'upgrade-'));
  const file=join(directory,'providers.json');
  const data={providers:[{id:'other',passHeaders:['Accept-Language']},{id:'agentrouter-relay',priceRate:2,passHeaders:['Originator']}],groups:[]};
  try {
    await writeFile(file,JSON.stringify(data));
    const load=createProvider('https://example.invalid/v1');
    await load({magpie:{},directory});
    data.providers[1].passHeaders.push('User-Agent');
    const configured=await readFile(file,'utf8');
    assert.deepEqual(JSON.parse(configured),data);
    await load({magpie:{},directory});
    assert.equal(await readFile(file,'utf8'),configured);
  } finally { await rm(file,{force:true}); await rmdir(directory); }
});
