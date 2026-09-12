// 一次性自检（跑完删除）：验收台是否可用——渲染、按钮动作、指标刷新
const CDP_PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const myId = ++id; pending.set(myId, (m) => res(m.result)); ws.send(JSON.stringify({ id: myId, method, params })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'ERR ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
await send('Runtime.enable');
await send('Page.navigate', { url: 'http://localhost:5180/' });
await sleep(9000);

// ① 面板渲染 + 清单数字
console.log('① 面板与清单:', await ev(`(() => {
  const text = document.body.innerText;
  const btns = [...document.querySelectorAll('button')].map(b => b.innerText.trim());
  return JSON.stringify({
    面板在: text.includes('功能验收台'),
    汇总行: (text.match(/93 条需求：[^\\n]*/) || [''])[0],
    已完成分组数: (text.match(/✅ /g) || []).length,
    待完成分组数: (text.match(/⏳ /g) || []).length,
    按钮数: btns.length,
    样例按钮: btns.filter(b => ['载入全部示例','开启全部控件','切不存在的底图','注入 3 条脏数据'].includes(b)),
  });
})()`));

// ② 逐个点按钮：控件 / 图元 / 批量 / 精度 / 底图 / 脏数据
const clickAndRead = async (label) => {
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === ${JSON.stringify(label)});
    if (!b) return false; b.click(); return true;
  })()`);
  await sleep(1400);
  const log = await ev(`(() => { const el = [...document.querySelectorAll('div')].find(d => d.innerText.includes('操作结果 / 事件')); return el ? el.innerText.split('\\n').slice(1, 3).join(' | ') : ''; })()`);
  return { label, clicked, log };
};
for (const label of ['开启全部控件', '载入全部示例', '批量加 2000 个点', '限制到 1km/像素', '切不存在的底图', '注入 3 条脏数据', '隐藏目标 001', '恢复显示', '取消精度限制', '关闭全部控件']) {
  const r = await clickAndRead(label);
  console.log(`② ${r.clicked ? '✓' : '✗'} ${r.label}  →  ${r.log}`);
}

// ③ 指标是否在刷新
console.log('③ 指标面板:', await ev(`(() => {
  const text = document.body.innerText;
  const m = text.match(/帧率 \\d+ fps[^\\n]*/);
  const p = text.match(/图元 [^\\n]*/);
  return JSON.stringify({ 指标行: m ? m[0] : null, 图元行: p ? p[0].slice(0, 90) : null });
})()`));
process.exit(0);
