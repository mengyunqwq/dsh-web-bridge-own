// lib/index.js — 兼容「注入器磁盘降级」的入口约定。
//
// 背景（2026-09-28 实测）：dsh-super-injector 的 dev_reload_package 在它自己的 import 缓存里
// 找不到模块时（DSH 重启后必然如此 —— 插件是 loader.create 装的、不走 loader.import，缓存是空的），
// 会退回磁盘按约定找 `<包目录>/lib/index.js` 再 import。而本插件的真实入口是**包根 index.js**
// （package.json 的 main/exports 都指向它），于是那条回退永远失败、报
// 「缓存中无匹配且磁盘降级失败」，改完代码只能重启 DSH 才生效。
//
// 这里只做再导出：让注入器按约定找到入口，import 后拿到的导出与包根完全一致
// （name / inject / Config / WebAdapter / apply）。不引入任何第二份实现。
export * from '../index.js';
