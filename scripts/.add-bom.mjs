// mission-app · 一次性小工具：给 .ps1 补 UTF-8 BOM
//
// 为什么需要它：Windows PowerShell 5.1 **按 ANSI(GBK) 读无 BOM 的 .ps1**，
// 中文字符串会被读坏（吞引号、报 "Unexpected token"）。所以含中文的 .ps1 必须存成 UTF-8 **with BOM**。
// 文件工具写出来的是无 BOM UTF-8，这个脚本只做一件事：读 UTF-8 → 原样写回，前面加 BOM。
//
// 用法：node .add-bom.mjs <文件路径>
import { readFileSync, writeFileSync } from 'node:fs'

const p = process.argv[2]
if (!p) { console.error('用法：node .add-bom.mjs <文件路径>'); process.exit(2) }
const text = readFileSync(p, 'utf8')
if (text.charCodeAt(0) === 0xFEFF) { console.log('已有 BOM，未改动：' + p); process.exit(0) }
writeFileSync(p, '\uFEFF' + text, 'utf8')
console.log('已补 BOM：' + p + '（' + Buffer.byteLength(text, 'utf8') + ' 字节 → ' + Buffer.byteLength('\uFEFF' + text, 'utf8') + ' 字节）')
