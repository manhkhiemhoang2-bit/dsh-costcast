/**
 * 生成浏览器包 client.js。
 *
 * 为什么要构建：浏览器侧的模块表只提供基线模块（React 等），
 * 自定义模块的 require 答不上来就会在加载时大声失败。
 * 所以估算逻辑必须内联进包体，不能在外层 import。
 *
 * 做法是把 src/estimate.js 与 src/component.js 的源码嵌进去，
 * 只把行首的 `export ` 去掉。两个文件的导出形式统一，
 * 不需要引入打包器。
 *
 * 脚本不调用子进程做语法检查；
 * 语法检查在外部单独跑 node --check。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** 去掉行首的 export 关键字，把 ESM 源码变成可内联的脚本片段。 */
const stripExports = (src) => src.replace(/^export /gm, '');

const estimateSrc = stripExports(readFileSync(join(here, 'src/estimate.js'), 'utf8'));
const componentSrc = stripExports(readFileSync(join(here, 'src/component.js'), 'utf8'));

// 内联后不能残留 import/export，否则浏览器直接语法错误
for (const [name, src] of [['estimate', estimateSrc], ['component', componentSrc]]) {
  if (/^\s*(import|export)\s/m.test(src)) {
    throw new Error(`${name}.js 内联后仍有 import/export，检查源码导出写法`);
  }
}

const bundle = `/**
 * dsh-costcast 浏览器半端。此文件由 build.mjs 生成，不要直接改。
 * 源码在 src/estimate.js 与 src/component.js。
 */
window.__ModuleLoader__.load({
  id: 'dsh-costcast',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    //#region src/estimate.js
${estimateSrc}
    //#endregion

    //#region src/component.js
${componentSrc}
    //#endregion

    const CostStrip = createCostStrip({
      React,
      h,
      estimate,
      costOf,
      formatTokens,
      formatCNY,
      formatRange,
      formatPercent,
      DEFAULT_MODEL,
    });

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'costcast',
              order: 5,
            },
            CostStrip,
          ),
        );
      },
    };
  },
});
`;

writeFileSync(join(here, 'client.js'), bundle, 'utf8');
console.log(`client.js 已生成：${bundle.length} 字节`);
