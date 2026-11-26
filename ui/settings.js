const budget = document.getElementById('retry-budget');
const save = document.getElementById('save');
const reset = document.getElementById('reset');
const status = document.getElementById('status');

function busy(value) {
  for (const element of [budget,save,reset]) element.disabled = value;
}

async function persist() {
  if (!budget.reportValidity()) return;
  busy(true);
  status.textContent = '正在保存…';
  try {
    const options = await magpie.options.get();
    const saved = await magpie.options.set({ ...options, retryBudgetSeconds:budget.valueAsNumber });
    budget.value = saved.retryBudgetSeconds;
    status.textContent = `已保存 ${saved.retryBudgetSeconds} 秒，后续请求生效。`;
  } catch (error) {
    status.textContent = `保存失败：${error.message}`;
  } finally {
    busy(false);
  }
}

async function initialize() {
  try {
    await magpie.ready;
    const options = await magpie.options.get();
    budget.value = options.retryBudgetSeconds ?? 300;
    status.textContent = '';
    busy(false);
  } catch (error) {
    status.textContent = `读取失败：${error.message}。请重新打开「设置 → 插件」。`;
  }
}

save.addEventListener('click',persist);
reset.addEventListener('click',() => { budget.value = 300; void persist(); });
budget.addEventListener('keydown',event => { if (event.key === 'Enter') void persist(); });
void initialize();
