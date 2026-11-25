import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function configureUA(directory) {
  const file = join(directory,'providers.json');
  const raw = await readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT') return null; throw error;});
  const data = raw === null ? {} : JSON.parse(raw);
  data.providers ??= [];
  if (!Array.isArray(data.providers)) throw new Error('喜鹊供应商文件格式不符，未修改。');
  let provider = data.providers.find(item => item.id === 'agentrouter-relay');
  if (!provider) { provider = {id:'agentrouter-relay'}; data.providers.push(provider); }
  const headers = provider.passHeaders ?? [];
  if (headers.some(name=>name.toLowerCase()==='user-agent')) return false;
  provider.passHeaders = [...headers,'User-Agent'];
  const updated = JSON.stringify(data,null,2)+'\n';
  if (raw === null) {
    await writeFile(file,updated,{flag:'wx',mode:0o600});
    return true;
  }
  const temporary = `${file}.ag-relay-${process.pid}.tmp`;
  await writeFile(temporary,updated,{flag:'wx',mode:(await stat(file)).mode & 0o777});
  try {
    if (await readFile(file,'utf8') !== raw) throw new Error('喜鹊配置已变更，本次未覆盖。');
    await rename(temporary,file);
  } finally { await unlink(temporary).catch(error=>{if(error.code!=='ENOENT') throw error;}); }
  return true;
}
